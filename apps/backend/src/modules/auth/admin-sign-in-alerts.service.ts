import { Injectable, Logger } from "@nestjs/common";
import { AdminRole } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AlertingService } from "../alerting/alerting.service";
import { EmailService } from "../email/email.service";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import { signInAlert, wrongPasswordsAlert, type SignInAlert } from "./admin-sign-in-alerts.emails";

/** Failed password counts for one admin account, within LoginGuard's
 * window, at which the owner is told -- the counts LoginGuard already
 * logs at, and one more. */
export const ATTACK_THRESHOLDS: readonly number[] = [10, 25, 50, 100];

/** At most this many "under attack" alerts an hour, across every account:
 * an attacker cycling addresses and names must not be able to bury the
 * owner's inbox in them. */
const ATTACK_ALERTS_PER_HOUR = 6;
const HOUR_MS = 3_600_000;

/** Who signs in to the admin panel, told to the owner as it happens.
 *
 * The panel is reachable from anywhere, and on 2026-10-18 its one
 * SUPERADMIN had no second factor and a password that had been pasted
 * into a chat. Nothing told anyone when that account was used. Now every
 * completed sign-in goes to the alert webhook and to every SUPERADMIN's
 * mailbox, with the address and network it came from -- a sign-in nobody
 * expected is the first sign of a stolen password -- and so does a run of
 * wrong passwords against an admin account, which LoginGuard only logged.
 *
 * Reseller sign-ins are left out: resellers sign in to sell, and an alert
 * for each would teach the owner to ignore them.
 *
 * Never throws and is never awaited by a sign-in: an alert that cannot be
 * delivered must not be the reason someone could not sign in. */
@Injectable()
export class AdminSignInAlertsService {
  private readonly logger = new Logger(AdminSignInAlertsService.name);
  private attackAlerts: number[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerting: AlertingService,
    private readonly email: EmailService,
    private readonly identity: NetworkIdentityService,
  ) {}

  /** An admin finished signing in: tokens were issued. `withMfa` when the
   * second step was a TOTP code. */
  async signedIn(email: string, ip: string | undefined, withMfa: boolean, now: Date = new Date()): Promise<void> {
    try {
      const admin = await this.adminByEmail(email);
      if (!admin || admin.role === AdminRole.RESELLER) return;
      await this.tell(signInAlert(admin, await this.describe(ip), withMfa, now));
    } catch (err) {
      this.logger.warn(`Sign-in alert not sent: ${(err as Error).message}`);
    }
  }

  /** A wrong password for `email`, now at `failures` within LoginGuard's
   * window. Told only at `ATTACK_THRESHOLDS`, only for an address that is
   * an admin's -- a guess at a name nobody has is noise -- and only within
   * the hourly cap. */
  async failed(email: string, failures: number, ip: string | undefined, now: number = Date.now()): Promise<void> {
    try {
      if (!ATTACK_THRESHOLDS.includes(failures)) return;
      this.attackAlerts = this.attackAlerts.filter((at) => now - at < HOUR_MS);
      if (this.attackAlerts.length >= ATTACK_ALERTS_PER_HOUR) return;
      const admin = await this.adminByEmail(email);
      if (!admin) return;
      this.attackAlerts.push(now);
      await this.tell(wrongPasswordsAlert(admin, failures, await this.describe(ip)));
    } catch (err) {
      this.logger.warn(`Failed-sign-in alert not sent: ${(err as Error).message}`);
    }
  }

  /** The admin an address belongs to, matched as LoginGuard counts it:
   * trimmed and in any case, so a guesser varying the case is still told
   * about. */
  private adminByEmail(email: string) {
    return this.prisma.adminUser.findFirst({
      where: { email: { equals: email.trim(), mode: "insensitive" } },
      select: { email: true, role: true },
    });
  }

  /** "203.0.113.10 (Example ISP, DE)", or the address alone when the
   * network table does not know it. */
  private async describe(ip: string | undefined): Promise<string> {
    if (!ip) return "an unknown address";
    try {
      const info = await this.identity.identify(ip);
      const country = this.identity.regionOf(ip);
      const parts = [info?.org, country].filter((part): part is string => typeof part === "string" && part.length > 0);
      return parts.length > 0 ? `${ip} (${parts.join(", ")})` : ip;
    } catch {
      return ip;
    }
  }

  /** The webhook, then every SUPERADMIN's mailbox. */
  private async tell({ subject, text, html, webhook }: SignInAlert): Promise<void> {
    await this.alerting.send(webhook);
    const owners = await this.prisma.adminUser.findMany({
      where: { role: AdminRole.SUPERADMIN },
      select: { email: true },
    });
    for (const owner of owners) await this.email.sendMail({ to: owner.email, subject, text, html });
  }
}

/** The email in an access token this service just saw issued: the
 * token is ours and fresh, and only its claim is read, never trusted for
 * anything else. Null for anything that is not a JWT with one. */
export function emailOfAccessToken(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}
