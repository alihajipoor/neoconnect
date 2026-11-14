/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-call -- the in-memory
   Prisma stand-in matches the real client's async, loosely typed shape. */
import { Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { createHash } from "node:crypto";
import { authenticator } from "otplib";
import { AdminAuditService } from "../admin-audit/admin-audit.service";
import { AdminsService } from "../admins/admins.service";
import { AuthService, type SignedIn } from "../auth/auth.service";
import { deviceLabel, MAX_TRUSTED_DEVICES, TRUST_MS, TrustedDevicesService } from "./trusted-devices.service";

/**
 * "Trust this device for 30 days", end to end through the real
 * AuthService, TrustedDevicesService, AdminsService, AdminAuditService,
 * argon2, otplib and JwtService. Only Postgres is replaced, by an
 * in-memory store that applies the same where-clauses the services send.
 */

const PASSWORD = "correct-password";
const SECRETS: Record<string, string> = { "jwt.accessSecret": "test-access", "jwt.refreshSecret": "test-refresh" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

interface Admin {
  id: string;
  email: string;
  passwordHash: string;
  role: "SUPERADMIN" | "SUPPORT" | "BILLING" | "RESELLER";
  mfaSecret: string | null;
  mfaEnabled: boolean;
  mfaLastStep: number | null;
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
}
interface Device {
  id: string;
  adminId: string;
  tokenHash: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

type Where = Record<string, any>;
const time = (d: Date) => d.getTime();
function matches(d: Device, where: Where): boolean {
  for (const [k, v] of Object.entries(where)) {
    const value = (d as any)[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v && !v.in.includes(value)) return false;
      if ("gt" in v && !(time(value) > time(v.gt))) return false;
      if ("lte" in v && !(time(value) <= time(v.lte))) return false;
    } else if (value !== v) return false;
  }
  return true;
}
const pick = (d: Device, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).map((k) => [k, (d as any)[k]])) : { ...d };

function fakePrisma() {
  const admins: Admin[] = [];
  let devices: Device[] = [];
  const audit: any[] = [];
  let n = 0;
  const adminWhere = (w: Where) => admins.find((a) => (w.id ? a.id === w.id : a.email === w.email));
  const prisma: any = {
    admins,
    audit,
    get devices() {
      return devices;
    },
    adminUser: {
      findUnique: async ({ where }: any) => adminWhere(where) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const a = adminWhere(where);
        if (!a) throw new Error("not found");
        return a;
      },
      update: async ({ where, data }: any) => {
        const a = adminWhere(where)!;
        for (const [k, v] of Object.entries(data)) {
          (a as any)[k] = v && typeof v === "object" && "increment" in (v as any) ? (a as any)[k] + (v as any).increment : v;
        }
        return a;
      },
      updateMany: async ({ where, data }: any) => {
        const a = adminWhere(where);
        if (!a) return { count: 0 };
        const ok = a.mfaLastStep === null || a.mfaLastStep < where.OR[1].mfaLastStep.lt;
        if (ok) Object.assign(a, data);
        return { count: ok ? 1 : 0 };
      },
    },
    adminAuditEntry: { create: async ({ data }: any) => audit.push(data), deleteMany: async () => ({ count: 0 }) },
    adminTrustedDevice: {
      create: async ({ data, select }: any) => {
        const d: Device = { id: `dev-${++n}`, ...data };
        devices.push(d);
        return pick(d, select);
      },
      findUnique: async ({ where, select }: any) => {
        const d = devices.find((x) => x.tokenHash === where.tokenHash);
        return d ? pick(d, select) : null;
      },
      findMany: async ({ where, select }: any) =>
        devices
          .filter((d) => matches(d, where))
          .sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id.localeCompare(a.id))
          .map((d) => pick(d, select)),
      updateMany: async ({ where, data }: any) => {
        const hit = devices.filter((d) => matches(d, where));
        hit.forEach((d) => Object.assign(d, data));
        return { count: hit.length };
      },
      deleteMany: async ({ where }: any) => {
        const before = devices.length;
        devices = devices.filter((d) => !matches(d, where));
        return { count: before - devices.length };
      },
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(prisma),
  };
  return prisma;
}

describe("trusted devices", () => {
  let hash: string;
  let prisma: ReturnType<typeof fakePrisma>;
  let trusted: TrustedDevicesService;
  let auth: AuthService;
  let admins: AdminsService;
  let logged: string[];

  beforeAll(async () => {
    hash = await argon2.hash(PASSWORD);
  });

  function addAdmin(id: string, mfa = true): Admin {
    const a: Admin = {
      id,
      email: `${id}@example.com`,
      passwordHash: hash,
      role: "SUPPORT",
      mfaSecret: mfa ? authenticator.generateSecret() : null,
      mfaEnabled: mfa,
      mfaLastStep: null,
      tokenVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma.admins.push(a);
    return a;
  }

  beforeEach(() => {
    prisma = fakePrisma();
    trusted = new TrustedDevicesService(prisma, new AdminAuditService(prisma));
    const config = { get: (k: string) => SECRETS[k] } as unknown as ConfigService;
    auth = new AuthService(prisma, new JwtService({}), config, trusted);
    admins = new AdminsService(prisma, trusted);
    logged = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    jest.spyOn(console, "log").mockImplementation((...args) => void logged.push(args.map(String).join(" ")));
  });

  afterEach(() => jest.restoreAllMocks());

  /** A full password + code sign-in, trusting the browser when asked. */
  async function signInWithCode(a: Admin, trust: boolean): Promise<SignedIn> {
    const first = await auth.login(a.email, PASSWORD);
    if (!("mfaRequired" in first)) throw new Error("expected the code step");
    // A fresh step each time, so the replay guard does not refuse it.
    a.mfaLastStep = null;
    return auth.verifyMfaAndLogin(first.mfaToken, authenticator.generate(a.mfaSecret!), { trust, userAgent: UA });
  }

  async function trustedToken(a: Admin): Promise<string> {
    const r = await signInWithCode(a, true);
    return r.trustedDevice!.token;
  }

  it("is not created when the box is not ticked", async () => {
    const a = addAdmin("a");
    const r = await signInWithCode(a, false);
    expect(r.accessToken).toBeTruthy();
    expect(r.trustedDevice).toBeUndefined();
    expect(prisma.devices).toHaveLength(0);
  });

  it("stores only the SHA-256 of a 256-bit token, a label and a 30-day fixed expiry", async () => {
    const a = addAdmin("a");
    const before = Date.now();
    const grant = (await signInWithCode(a, true)).trustedDevice!;
    expect(Buffer.from(grant.token, "base64url")).toHaveLength(32);
    const [row] = prisma.devices;
    expect(row.tokenHash).toBe(sha(grant.token));
    expect(JSON.stringify(row)).not.toContain(grant.token);
    expect(row.label).toBe("Chrome on Windows");
    expect(time(row.expiresAt) - time(row.createdAt)).toBe(TRUST_MS);
    expect(time(row.createdAt)).toBeGreaterThanOrEqual(before);
  });

  it("skips the code after a correct password, and rotates the token keeping the expiry", async () => {
    const a = addAdmin("a");
    const token = await trustedToken(a);
    const expiry = prisma.devices[0].expiresAt;

    const r = await auth.login(a.email, PASSWORD, token);
    expect("mfaRequired" in r).toBe(false);
    const signed = r as SignedIn;
    expect(signed.accessToken).toBeTruthy();
    expect(signed.trustedDevice!.token).not.toBe(token);
    expect(time(signed.trustedDevice!.expiresAt)).toBe(time(expiry));
    expect(prisma.devices).toHaveLength(1);
    expect(time(prisma.devices[0].expiresAt)).toBe(time(expiry));

    // The old token stops working; the new one works.
    expect("mfaRequired" in (await auth.login(a.email, PASSWORD, token))).toBe(true);
    expect("mfaRequired" in (await auth.login(a.email, PASSWORD, signed.trustedDevice!.token))).toBe(false);
  });

  it("still refuses a wrong password with a valid token, and does not spend the token", async () => {
    const a = addAdmin("a");
    const token = await trustedToken(a);
    await expect(auth.login(a.email, "wrong-password", token)).rejects.toThrow(UnauthorizedException);
    expect(prisma.devices[0].tokenHash).toBe(sha(token));
  });

  it("asks for the code for no, unknown, expired, removed and another account's token", async () => {
    const a = addAdmin("a");
    const b = addAdmin("b");
    const tokenA = await trustedToken(a);
    const tokenB = await trustedToken(b);
    const asks = async (token?: string) => {
      const r = await auth.login(a.email, PASSWORD, token);
      return "mfaRequired" in r && Object.keys(r).sort().join();
    };
    const plain = await asks(undefined);
    expect(plain).toBe("mfaRequired,mfaToken");
    expect(await asks("not-a-token")).toBe(plain);
    expect(await asks(tokenB)).toBe(plain);
    // B's token was not spent or touched by A's attempt.
    expect("mfaRequired" in (await auth.login(b.email, PASSWORD, tokenB))).toBe(false);

    // Expired: the clock passes the fixed expiry, then the row's own
    // expiry is put in the past and the real login path asks for the code.
    expect(await trusted.redeem(a, tokenA, undefined, new Date(Date.now() + TRUST_MS + 1000))).toBeNull();
    const rowA = prisma.devices.find((d: Device) => d.adminId === a.id)!;
    const kept = rowA.expiresAt;
    rowA.expiresAt = new Date(Date.now() - 1000);
    expect(await asks(tokenA)).toBe(plain);
    rowA.expiresAt = kept;
    // Still this browser's until removed.
    const used = (await auth.login(a.email, PASSWORD, tokenA)) as SignedIn;
    expect(used.trustedDevice).toBeDefined();
    const tokenA2 = used.trustedDevice!.token;

    // Removed.
    await trusted.revokeAll(a, "removed by the admin");
    expect(await asks(tokenA2)).toBe(plain);
  });

  it("does not slide the expiry however often it is used", async () => {
    const a = addAdmin("a");
    let token = await trustedToken(a);
    const expiry = time(prisma.devices[0].expiresAt);
    for (let i = 1; i <= 3; i++) {
      const g = await trusted.redeem(a, token, undefined, new Date(Date.now() + i * 24 * 3_600_000));
      expect(time(g!.expiresAt)).toBe(expiry);
      expect(time(prisma.devices[0].expiresAt)).toBe(expiry);
      token = g!.token;
    }
    expect(time(prisma.devices[0].lastUsedAt)).toBeGreaterThan(time(prisma.devices[0].createdAt));
  });

  it("changes nothing for an account without two-factor", async () => {
    const a = addAdmin("a", false);
    const r = await auth.login(a.email, PASSWORD, "anything");
    expect(r).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String) });
  });

  it("keeps at most five per account; a sixth removes the oldest", async () => {
    const a = addAdmin("a");
    const tokens: string[] = [];
    for (let i = 0; i < MAX_TRUSTED_DEVICES + 1; i++) {
      const now = new Date(Date.now() + i * 1000);
      tokens.push((await trusted.trust(a, UA, undefined, now)).token);
    }
    expect(prisma.devices).toHaveLength(MAX_TRUSTED_DEVICES);
    expect(prisma.devices.some((d: Device) => d.tokenHash === sha(tokens[0]))).toBe(false);
    expect(prisma.devices.some((d: Device) => d.tokenHash === sha(tokens[5]))).toBe(true);
  });

  describe("revoked everywhere", () => {
    let a: Admin;
    beforeEach(async () => {
      a = addAdmin("a");
      await trustedToken(a);
      await trustedToken(a);
      addAdmin("other");
      await trustedToken(prisma.admins[1]);
    });
    const mine = () => prisma.devices.filter((d: Device) => d.adminId === a.id).length;

    it("when the password changes", async () => {
      await admins.update(a.id, { password: "a-new-password" });
      expect(mine()).toBe(0);
      expect(prisma.devices).toHaveLength(1);
    });
    it("when the role changes", async () => {
      await admins.update(a.id, { role: "BILLING" as any });
      expect(mine()).toBe(0);
    });
    it("but not when the role is set to what it already is", async () => {
      await admins.update(a.id, { role: "SUPPORT" as any });
      expect(mine()).toBe(2);
    });
    it("when two-factor is turned off", async () => {
      await auth.disableMfa(a.id, PASSWORD);
      expect(mine()).toBe(0);
    });
    it("when two-factor is set up again", async () => {
      await auth.disableMfa(a.id, PASSWORD);
      await trusted.trust(a, UA); // as if left behind
      await auth.setupMfa(a.id);
      expect(mine()).toBe(0);
      await trusted.trust(a, UA);
      a.mfaLastStep = null;
      await auth.enableMfa(a.id, authenticator.generate(a.mfaSecret!));
      expect(mine()).toBe(0);
    });
    it("records the removal in the audit log", () => {
      return admins.update(a.id, { password: "a-new-password" }).then(() => {
        expect(prisma.audit.some((e: any) => e.path === "trusted-device/removed: password changed (2)")).toBe(true);
      });
    });
  });

  it("lists the account's own, without hashes, and removes one or all", async () => {
    const a = addAdmin("a");
    const b = addAdmin("b");
    await trustedToken(a);
    await trustedToken(a);
    await trustedToken(b);
    const list = await trusted.list(a.id);
    expect(list).toHaveLength(2);
    for (const d of list) expect(Object.keys(d).sort()).toEqual(["createdAt", "expiresAt", "id", "label", "lastUsedAt"]);

    const bDevice = prisma.devices.find((d: Device) => d.adminId === b.id)!;
    await expect(trusted.remove(a, bDevice.id)).rejects.toThrow(NotFoundException);
    expect(prisma.devices).toHaveLength(3);

    await trusted.remove(a, list[0].id);
    expect((await trusted.list(a.id)).map((d) => d.id)).toEqual([list[1].id]);
    await trusted.revokeAll(a, "removed by the admin");
    expect(await trusted.list(a.id)).toEqual([]);
    expect(await trusted.list(b.id)).toHaveLength(1);
  });

  it("audits trusted, used and removed, and never writes or logs a token", async () => {
    const a = addAdmin("a");
    const t1 = await trustedToken(a);
    const r = (await auth.login(a.email, PASSWORD, t1)) as SignedIn;
    const t2 = r.trustedDevice!.token;
    await auth.login(a.email, PASSWORD, "garbage-token");
    await trusted.revokeAll(a, "removed by the admin");
    expect(prisma.audit.map((e: any) => e.path)).toEqual([
      "trusted-device/trusted",
      "trusted-device/used",
      "trusted-device/removed: removed by the admin (1)",
    ]);
    const everything = JSON.stringify(prisma.audit) + logged.join("\n") + JSON.stringify(prisma.devices);
    for (const t of [t1, t2]) expect(everything).not.toContain(t);
  });

  it("labels common browsers", () => {
    expect(deviceLabel(UA)).toBe("Chrome on Windows");
    expect(
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1"),
    ).toBe("Safari on iOS");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on Linux");
    expect(deviceLabel(`${UA} Edg/142.0`)).toBe("Edge on Windows");
    expect(deviceLabel(undefined)).toBe("A browser on an unknown system");
  });
});
