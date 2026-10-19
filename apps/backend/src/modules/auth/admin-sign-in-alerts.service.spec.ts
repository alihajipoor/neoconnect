import { Logger } from "@nestjs/common";
import { AdminSignInAlertsService, ATTACK_THRESHOLDS, emailOfAccessToken } from "./admin-sign-in-alerts.service";

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

const OWNER = { email: "owner@example.com", role: "SUPERADMIN" };
const SUPPORT = { email: "support@example.com", role: "SUPPORT" };
const RESELLER = { email: "seller@example.com", role: "RESELLER" };

function build(admins: { email: string; role: string }[] = [OWNER, SUPPORT, RESELLER]) {
  const webhooks: string[] = [];
  const mails: { to: string; subject: string; text: string; html: string }[] = [];
  const prisma = {
    adminUser: {
      findFirst: jest.fn(({ where }: { where: { email: { equals: string } } }) =>
        Promise.resolve(admins.find((a) => a.email.toLowerCase() === where.email.equals.toLowerCase()) ?? null),
      ),
      findMany: jest.fn(() => Promise.resolve(admins.filter((a) => a.role === "SUPERADMIN"))),
    },
  };
  const alerting = { send: jest.fn((message: string) => Promise.resolve(void webhooks.push(message))) };
  const email = { sendMail: jest.fn((mail: (typeof mails)[number]) => Promise.resolve(Boolean(mails.push(mail)))) };
  const identity = {
    identify: jest.fn(() => Promise.resolve({ asn: 64500, org: "Example ISP" })),
    regionOf: jest.fn(() => "DE"),
  };
  const service = new AdminSignInAlertsService(prisma as never, alerting as never, email as never, identity as never);
  return { service, webhooks, mails, alerting, email };
}

describe("AdminSignInAlertsService sign-ins", () => {
  it("tells the webhook and every SUPERADMIN, with the address and its network", async () => {
    const { service, webhooks, mails } = build();
    await service.signedIn("support@example.com", "203.0.113.10", true, new Date("2026-10-18T03:00:00Z"));
    expect(webhooks).toEqual(["[admin] Sign-in: support@example.com from 203.0.113.10 (Example ISP, DE)"]);
    expect(mails.map((m) => m.to)).toEqual(["owner@example.com"]);
    expect(mails[0].text).toContain("with two-factor");
    expect(mails[0].text).toContain("2026-10-18T03:00:00.000Z from 203.0.113.10 (Example ISP, DE)");
  });

  // The account this was written for had none.
  it("says so when the sign-in had no second factor", async () => {
    const { service, mails } = build();
    await service.signedIn("owner@example.com", "203.0.113.10", false);
    expect(mails[0].text).toContain("with a password only -- this account has no two-factor");
  });

  it("leaves resellers out, and addresses that are no admin's", async () => {
    const { service, webhooks, mails } = build();
    await service.signedIn("seller@example.com", "203.0.113.10", false);
    await service.signedIn("nobody@example.com", "203.0.113.10", false);
    expect(webhooks).toEqual([]);
    expect(mails).toEqual([]);
  });

  it("escapes what it puts in the mail's HTML", async () => {
    const { service, mails } = build([{ email: "a<b>@example.com", role: "SUPERADMIN" }]);
    await service.signedIn("a<b>@example.com", undefined, true);
    expect(mails[0].html).toContain("a&lt;b&gt;@example.com");
    expect(mails[0].html).not.toContain("<b>");
    expect(mails[0].text).toContain("from an unknown address");
  });

  // A broken mail server or webhook must never be why a sign-in failed.
  it("never throws", async () => {
    const { service, alerting } = build();
    alerting.send.mockRejectedValueOnce(new Error("webhook down"));
    await expect(service.signedIn("owner@example.com", "203.0.113.10", true)).resolves.toBeUndefined();
  });
});

describe("AdminSignInAlertsService wrong passwords", () => {
  it("speaks only at the thresholds", async () => {
    const { service, webhooks } = build();
    for (let n = 1; n <= 30; n += 1) await service.failed("owner@example.com", n, "198.51.100.10");
    expect(webhooks).toEqual([
      "[admin] 10 wrong passwords for owner@example.com, latest from 198.51.100.10 (Example ISP, DE)",
      "[admin] 25 wrong passwords for owner@example.com, latest from 198.51.100.10 (Example ISP, DE)",
    ]);
    expect(ATTACK_THRESHOLDS).toContain(50);
  });

  // LoginGuard counts the account however its address is cased.
  it("matches the admin's address in any case", async () => {
    const { service, webhooks } = build();
    await service.failed("  OWNER@Example.com ", 10, "198.51.100.10");
    expect(webhooks).toHaveLength(1);
  });

  it("says nothing about addresses that are no admin's", async () => {
    const { service, webhooks, mails } = build();
    await service.failed("guess@example.com", 10, "198.51.100.10");
    expect(webhooks).toEqual([]);
    expect(mails).toEqual([]);
  });

  // An attacker cycling names and addresses cannot bury the owner in them.
  it("sends at most six an hour", async () => {
    const admins = Array.from({ length: 10 }, (_, i) => ({ email: `a${i}@example.com`, role: "SUPPORT" }));
    const { service, webhooks } = build([OWNER, ...admins]);
    const now = Date.UTC(2026, 9, 18);
    for (const admin of admins) await service.failed(admin.email, 10, "198.51.100.10", now);
    expect(webhooks).toHaveLength(6);
    await service.failed("a9@example.com", 25, "198.51.100.10", now + 3_600_001);
    expect(webhooks).toHaveLength(7);
  });
});

describe("emailOfAccessToken", () => {
  it("reads the email claim, and nothing from junk", () => {
    const token = `x.${Buffer.from(JSON.stringify({ sub: "1", email: "owner@example.com" })).toString("base64url")}.y`;
    expect(emailOfAccessToken(token)).toBe("owner@example.com");
    for (const junk of [undefined, "", "abc", "a.!!.b", `a.${Buffer.from("{}").toString("base64url")}.b`]) {
      expect(emailOfAccessToken(junk)).toBeNull();
    }
  });
});
