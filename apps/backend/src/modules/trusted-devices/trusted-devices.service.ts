import { Injectable, NotFoundException } from "@nestjs/common";
import type { AdminRole } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { AdminAuditService } from "../admin-audit/admin-audit.service";

/** How long a trusted browser skips the code. Fixed at creation: using
 * the device never moves it. */
export const TRUST_DAYS = 30;
export const TRUST_MS = TRUST_DAYS * 24 * 3_600_000;
/** Trusted browsers one account may have. A further one removes the
 * oldest. */
export const MAX_TRUSTED_DEVICES = 5;

/** What the panel's server puts in the browser's cookie. Never sent on to
 * the page, never logged. */
export interface TrustedDeviceGrant {
  token: string;
  id: string;
  expiresAt: Date;
}

/** Whose devices, for the audit log. */
export interface TrustSubject {
  id: string;
  email: string;
  role: AdminRole;
}

export interface TrustedDeviceView {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

export type RevokeReason =
  | "password changed"
  | "role changed"
  | "two-factor turned off"
  | "two-factor set up again"
  | "removed by the admin";

const sha256 = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
/** 256 random bits. */
const newToken = () => randomBytes(32).toString("base64url");

/** "Chrome on Windows" from a User-Agent. Display only: it is whatever the
 * browser said, and nothing is decided on it. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "A browser";
  const system = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "an unknown system";
  return `${browser} on ${system}`;
}

/**
 * Browsers an admin trusted at the two-factor step ("Trust this device
 * for 30 days").
 *
 * The password is always asked for; a valid token for the same account
 * only stands in for the code. The token is 256 random bits, only its
 * SHA-256 is stored, and each use replaces it (the old one stops working
 * in the same conditional write, so two racing uses cannot both pass)
 * while the expiry stays where creation put it.
 *
 * Trusted, used and removed are written to the admin audit log; the token
 * never is.
 */
@Injectable()
export class TrustedDevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Trust this browser for `admin`, after a full password + code sign-in.
   * Expired rows go, and past the limit the oldest go. */
  async trust(admin: TrustSubject, userAgent: string | undefined, ip?: string, now = new Date()): Promise<TrustedDeviceGrant> {
    const token = newToken();
    const expiresAt = new Date(now.getTime() + TRUST_MS);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.adminTrustedDevice.deleteMany({ where: { adminId: admin.id, expiresAt: { lte: now } } });
      const created = await tx.adminTrustedDevice.create({
        data: {
          adminId: admin.id,
          tokenHash: sha256(token),
          label: deviceLabel(userAgent).slice(0, 64),
          createdAt: now,
          lastUsedAt: now,
          expiresAt,
        },
        select: { id: true },
      });
      const keep = await tx.adminTrustedDevice.findMany({
        where: { adminId: admin.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      const over = keep.filter((d) => d.id !== created.id).slice(MAX_TRUSTED_DEVICES - 1).map((d) => d.id);
      if (over.length) await tx.adminTrustedDevice.deleteMany({ where: { id: { in: over } } });
      return created;
    });
    await this.event(admin, "trusted", ip);
    return { token, id: row.id, expiresAt };
  }

  /**
   * Spend `token` for `admin`: a fresh token on the same row and expiry
   * when it is this account's, unexpired and current; null for anything
   * else. Null is all the caller learns -- missing, unknown, expired,
   * replaced, removed and another account's look the same, and each costs
   * the same one lookup (a missing token is looked up as a random one).
   */
  async redeem(admin: TrustSubject, token: string | undefined, ip?: string, now = new Date()): Promise<TrustedDeviceGrant | null> {
    const hash = sha256(token || newToken());
    const row = await this.prisma.adminTrustedDevice.findUnique({
      where: { tokenHash: hash },
      select: { id: true, adminId: true, expiresAt: true },
    });
    if (!row || row.adminId !== admin.id || row.expiresAt.getTime() <= now.getTime()) return null;
    const next = newToken();
    const { count } = await this.prisma.adminTrustedDevice.updateMany({
      where: { id: row.id, adminId: admin.id, tokenHash: hash, expiresAt: { gt: now } },
      data: { tokenHash: sha256(next), lastUsedAt: now },
    });
    if (count !== 1) return null;
    await this.event(admin, "used", ip);
    return { token: next, id: row.id, expiresAt: row.expiresAt };
  }

  /** The account's unexpired trusted browsers, newest first. No hashes. */
  list(adminId: string, now = new Date()): Promise<TrustedDeviceView[]> {
    return this.prisma.adminTrustedDevice.findMany({
      where: { adminId, expiresAt: { gt: now } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, label: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
  }

  /** One of the account's own browsers; another account's id is not found. */
  async remove(admin: TrustSubject, id: string, ip?: string): Promise<void> {
    const { count } = await this.prisma.adminTrustedDevice.deleteMany({ where: { id, adminId: admin.id } });
    if (count === 0) throw new NotFoundException("Trusted device not found");
    await this.event(admin, "removed", ip, "removed by the admin");
  }

  /** Every trusted browser of the account. */
  async revokeAll(admin: TrustSubject, reason: RevokeReason, ip?: string): Promise<number> {
    const { count } = await this.prisma.adminTrustedDevice.deleteMany({ where: { adminId: admin.id } });
    if (count > 0) await this.event(admin, "removed", ip, `${reason} (${count})`);
    return count;
  }

  /** AdminAuditService.record never throws. */
  private event(admin: TrustSubject, what: "trusted" | "used" | "removed", ip?: string, why?: string) {
    return this.audit.record({
      adminId: admin.id,
      email: admin.email,
      role: admin.role,
      method: "EVENT",
      path: `trusted-device/${what}${why ? `: ${why}` : ""}`,
      status: 200,
      ip,
    });
  }
}
