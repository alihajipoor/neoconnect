/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-call -- the
   Prisma stand-in is a loose object matching the client's async signatures. */
import { ForbiddenException, HttpException, Logger } from "@nestjs/common";
import { RelayAuthMode } from "@prisma/client";
import type { RelayContext } from "../../common/relay/relay-arrival";
import { RelayAuthService } from "./relay-auth.service";
import { BUCKET_MS, bucketStart } from "./relay-policy";

const DAY = 86_400_000;
const IP = "192.0.2.77";

function ctx(over: Partial<RelayContext> = {}): RelayContext {
  return { box: "ir-a", asn: 64500, region: "IR", ip: IP, ipKey: "relay:caller-1", ...over };
}

/** A Postgres stand-in holding just what this service touches, and a log
 * of every call made to it -- so a test can say what was never written. */
function world(settingsOver: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const log =
    <T extends (...args: never[]) => unknown>(fn: T) =>
    (...args: Parameters<T>) => {
      calls.push(args);
      return fn(...args);
    };
  let settings: Record<string, unknown> = {
    id: "s1",
    mode: RelayAuthMode.AUTO,
    hostingAsns: [] as number[],
    intranetDeclaredAt: null,
    intranetEndedAt: null,
    suspectedSince: null,
    suspicionAlertedAt: null,
    capsRaisedAt: null,
    updatedAt: new Date(),
    ...settingsOver,
  };
  const stats = new Map<string, { day: Date; box: string; asn: number; signups: number; signIns: number; refusals: number }>();
  const buckets = new Map<number, { start: Date; ir: number; other: number }>();
  const prisma: any = {
    relayAuthSettings: {
      findFirst: jest.fn(log(async () => ({ ...settings }))),
      create: jest.fn(log(async () => ({ ...settings }))),
      update: jest.fn(
        log(async ({ data }: { data: Record<string, unknown> }) => {
          settings = { ...settings, ...data };
          return { ...settings };
        }),
      ),
    },
    relayDailyStat: {
      upsert: jest.fn(
        log(
          async ({
            where,
            create,
            update,
          }: {
            where: { day_box_asn: { day: Date; box: string; asn: number } };
            create: { signups: number; signIns: number; refusals: number };
            update: Record<string, { increment: number }>;
          }) => {
            const k = `${where.day_box_asn.day.toISOString()}|${where.day_box_asn.box}|${where.day_box_asn.asn}`;
            const row = stats.get(k);
            if (!row) stats.set(k, { ...where.day_box_asn, ...create });
            else for (const [f, v] of Object.entries(update)) (row as unknown as Record<string, number>)[f] += v.increment;
          },
        ),
      ),
      groupBy: jest.fn(
        log(async ({ where }: { where: { day: Date } }) => {
          const sums = new Map<number, number>();
          for (const r of stats.values()) {
            if (r.day.getTime() === where.day.getTime()) sums.set(r.asn, (sums.get(r.asn) ?? 0) + r.signups);
          }
          return [...sums].map(([asn, signups]) => ({ asn, _sum: { signups } }));
        }),
      ),
      findMany: jest.fn(log(async () => [...stats.values()])),
    },
    relayTrafficBucket: {
      upsert: jest.fn(log(async () => ({}))),
      deleteMany: jest.fn(log(async () => ({ count: 0 }))),
      findMany: jest.fn(log(async () => [...buckets.values()])),
    },
    customer: {
      updateMany: jest.fn(log(async () => ({ count: 1 }))),
      findMany: jest.fn(log(async () => [] as { id: string }[])),
      deleteMany: jest.fn(log(async () => ({ count: 0 }))),
    },
    subscription: { count: jest.fn(log(async () => 0)) },
    adminUser: { findMany: jest.fn(log(async () => [{ email: "owner@example.com" }])) },
  };
  const asn = { regionOf: jest.fn(), orgOf: jest.fn(() => null) };
  const identity = { isOwnAddress: jest.fn(async () => false) };
  const alerting = { send: jest.fn(async () => undefined) };
  const email = { sendMail: jest.fn(async () => true) };
  const service = new RelayAuthService(prisma as never, asn as never, identity as never, alerting as never, email as never);
  const seed = (asnNumber: number, signups: number, box = "ir-a") => {
    const day = new Date(Math.floor(Date.now() / DAY) * DAY);
    stats.set(`${day.toISOString()}|${box}|${asnNumber}`, { day, box, asn: asnNumber, signups, signIns: 0, refusals: 0 });
  };
  return { service, prisma, calls, stats, buckets, alerting, email, seed, settings: () => settings };
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    if (err instanceof HttpException) return (err.getResponse() as { code?: string }).code;
    throw err;
  }
}

async function signUps(service: RelayAuthService, n: number, over: Partial<RelayContext> = {}) {
  for (let i = 0; i < n; i += 1) {
    const r = await service.reserveSignup(ctx({ ipKey: `relay:caller-${i}`, ...over }));
    await r.commit();
  }
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});

describe("relay sign-up gate (R3.1)", () => {
  it("is shut when the owner switched it off", async () => {
    const { service } = world({ mode: RelayAuthMode.OFF });
    expect(await refusal(service.reserveSignup(ctx()))).toBe("RELAY_SIGNUP_OFF");
    expect(await refusal(service.assertSignupOpen(ctx()))).toBe("RELAY_SIGNUP_OFF");
  });

  it("wants a network registered in Iran, and a known one", async () => {
    const { service } = world();
    expect(await refusal(service.reserveSignup(ctx({ region: "DE" })))).toBe("RELAY_REGION");
    // Unknown is said apart from outside Iran: the app switches the relay
    // off for a day only on RELAY_REGION.
    expect(await refusal(service.reserveSignup(ctx({ region: null, asn: null })))).toBe("RELAY_REGION_UNKNOWN");
    expect(await refusal(service.assertSignupOpen(ctx({ region: null })))).toBe("RELAY_REGION_UNKNOWN");
    expect(await refusal(service.assertSignupOpen(ctx({ region: "IR", asn: null })))).toBe("RELAY_REGION_UNKNOWN");
    await expect(service.assertSignupOpen(ctx({ region: null }))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("relay sign-up caps (R3.5)", () => {
  it("holds the day at 200, counting what is already in the table", async () => {
    const { service, seed } = world();
    seed(64999, 199);
    await signUps(service, 1, { asn: 64501 });
    expect(await refusal(service.reserveSignup(ctx({ asn: 64502, ipKey: "relay:other" })))).toBe("RELAY_SIGNUP_LIMIT");
  });

  it("raises the day to 3,000 once the detector has raised the caps", async () => {
    const { service, seed } = world({ capsRaisedAt: new Date() });
    seed(64999, 700);
    await expect(service.reserveSignup(ctx({ asn: 64501 }))).resolves.toBeDefined();
  });

  it("holds one caller to 30 a day", async () => {
    const { service } = world({ mode: RelayAuthMode.INTRANET });
    for (let i = 0; i < 30; i += 1) await (await service.reserveSignup(ctx({ asn: 64500 + (i % 5) }))).commit();
    expect(await refusal(service.reserveSignup(ctx({ asn: 64510 })))).toBe("RELAY_SIGNUP_LIMIT");
  });

  it("holds one network to a quarter of the day", async () => {
    const { service } = world();
    await signUps(service, 50);
    expect(await refusal(service.reserveSignup(ctx({ ipKey: "relay:new" })))).toBe("RELAY_SIGNUP_LIMIT");
    await expect(service.reserveSignup(ctx({ asn: 64501, ipKey: "relay:new" }))).resolves.toBeDefined();
  });

  it("holds the listed hosting networks together to 5%", async () => {
    const { service } = world({ hostingAsns: [64700, 64701] });
    await signUps(service, 6, { asn: 64700 });
    await signUps(service, 4, { asn: 64701 });
    expect(await refusal(service.reserveSignup(ctx({ asn: 64701, ipKey: "relay:new" })))).toBe("RELAY_SIGNUP_LIMIT");
    await expect(service.reserveSignup(ctx({ asn: 64500, ipKey: "relay:new" }))).resolves.toBeDefined();
  });

  it("gives a place back when the sign-up does not happen", async () => {
    const { service, seed } = world();
    seed(64999, 199);
    (await service.reserveSignup(ctx())).release();
    await expect(service.reserveSignup(ctx())).resolves.toBeDefined();
  });

  it("counts a refusal, by box and network", async () => {
    const { service, seed, stats } = world();
    seed(64999, 200);
    await refusal(service.reserveSignup(ctx()));
    const row = [...stats.values()].find((r) => r.asn === 64500);
    expect(row).toMatchObject({ box: "ir-a", refusals: 1, signups: 0 });
  });

  it("asks more work of a caller past three sign-ups in an hour", async () => {
    const { service } = world({ mode: RelayAuthMode.INTRANET });
    expect(service.signupPowBits(ctx())).toBe(18);
    for (let i = 0; i < 3; i += 1) await (await service.reserveSignup(ctx({ asn: 64500 + i }))).commit();
    expect(service.signupPowBits(ctx())).toBe(20);
    expect(service.signupPowBits(ctx({ ipKey: "relay:someone-else" }))).toBe(18);
  });
});

/** Asked only when an unverified account would become relay-unverified;
 * one that already is signs in without asking (customer-auth.relay.spec). */
describe("an unverified sign-in over the relay (R4.2)", () => {
  it("holds a place under the sign-up caps for the account's first conversion", async () => {
    const { service, seed } = world();
    seed(64999, 199);
    const place = await service.admitUnverifiedSignIn(ctx(), "c1", 18);
    expect(place).not.toBeNull();
    // The last place is held: a sign-up now is refused.
    expect(await refusal(service.reserveSignup(ctx({ ipKey: "relay:other" })))).toBe("RELAY_SIGNUP_LIMIT");
    place!.release();
    await expect(service.reserveSignup(ctx({ ipKey: "relay:other" }))).resolves.toBeDefined();
  });

  it("asks at least the sign-up's work before it takes a place (F4)", async () => {
    const { service, seed } = world();
    seed(64999, 199);
    // A sign-in under the login guard's grace proves no work at all.
    expect(await refusal(service.admitUnverifiedSignIn(ctx(), "c1", 0))).toBe("CHALLENGE_REQUIRED");
    expect(await refusal(service.admitUnverifiedSignIn(ctx(), "c1", 12))).toBe("CHALLENGE_REQUIRED");
    // Nothing was held by the refusals.
    await expect(service.reserveSignup(ctx({ ipKey: "relay:other" }))).resolves.toBeDefined();
  });

  it("says why it refuses -- never 'verify your email', which an intranet makes impossible", async () => {
    expect(await refusal(world({ mode: RelayAuthMode.OFF }).service.admitUnverifiedSignIn(ctx(), "c1", 18))).toBe(
      "RELAY_SIGNUP_OFF",
    );
    expect(await refusal(world().service.admitUnverifiedSignIn(ctx({ region: null }), "c1", 18))).toBe(
      "RELAY_REGION_UNKNOWN",
    );
    const full = world();
    full.seed(64999, 200);
    expect(await refusal(full.service.admitUnverifiedSignIn(ctx(), "c1", 18))).toBe("RELAY_SIGNUP_LIMIT");
  });

  it("never caps an account holding paid access, whatever the switch says (paying users are never locked out)", async () => {
    const { service, seed, prisma } = world({ mode: RelayAuthMode.OFF });
    seed(64999, 200);
    prisma.subscription.count.mockResolvedValueOnce(1);
    expect(await service.admitUnverifiedSignIn(ctx(), "c1", 0)).toBeNull();
    expect(prisma.subscription.count).toHaveBeenCalledWith({
      where: {
        customerId: "c1",
        OR: [{ status: "ACTIVE" }, { status: { not: "PENDING" }, plan: { relayOnly: true } }],
      },
    });
  });
});

/** I5: nothing about a relay caller's address is written anywhere. */
describe("no relay address is persisted", () => {
  it("is in no call to the database, whatever happens", async () => {
    const { service, calls, seed } = world();
    await (await service.reserveSignup(ctx())).commit();
    await service.recordSignIn(ctx());
    seed(64999, 500);
    await refusal(service.reserveSignup(ctx()));
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).not.toContain(IP);
    expect(JSON.stringify(calls)).not.toContain("relay:caller-1");
  });
});

describe("mail to relay-unverified accounts (R3.7)", () => {
  const account = (over = {}) => ({ id: "c1", emailVerifiedAt: null, relayUnverifiedSince: new Date(), ...over });

  it("does not limit anyone else", async () => {
    const { service, prisma } = world();
    expect(await service.takeRelayMail(account({ relayUnverifiedSince: null }))).toBe(true);
    expect(await service.takeRelayMail(account({ emailVerifiedAt: new Date() }))).toBe(true);
    expect(prisma.customer.updateMany).not.toHaveBeenCalled();
  });

  it("takes the day's mail for an address in one conditional write", async () => {
    const { service, prisma } = world();
    expect(await service.takeRelayMail(account())).toBe(true);
    expect(prisma.customer.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", OR: [{ relayMailAt: null }, { relayMailAt: { lt: expect.any(Date) } }] },
      data: { relayMailAt: expect.any(Date) },
    });
    prisma.customer.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await service.takeRelayMail(account())).toBe(false);
  });

  it("stops at the day's total", async () => {
    const { service } = world();
    for (let i = 0; i < 200; i += 1) expect(await service.takeRelayMail(account({ id: `c${i}` }))).toBe(true);
    expect(await service.takeRelayMail(account({ id: "one-more" }))).toBe(false);
  });
});

describe("the intranet hold (R3.8, R4.5)", () => {
  it("lasts through a declared intranet and 30 days after it", async () => {
    const now = Date.now();
    expect(await world({ mode: RelayAuthMode.INTRANET }).service.intranetHold(now)).toBe(true);
    expect(await world({ intranetEndedAt: new Date(now - 10 * DAY) }).service.intranetHold(now)).toBe(true);
    expect(await world({ intranetEndedAt: new Date(now - 31 * DAY) }).service.intranetHold(now)).toBe(false);
    expect(await world({ capsRaisedAt: new Date() }).service.intranetHold(now)).toBe(false);
  });

  it("holds sessions only of customers with an active relay plan", async () => {
    const held = world({ mode: RelayAuthMode.INTRANET });
    held.prisma.subscription.count.mockResolvedValue(1);
    expect(await held.service.holdsSessionsOf("c1")).toBe(true);
    expect(held.prisma.subscription.count).toHaveBeenCalledWith({
      where: { customerId: "c1", status: "ACTIVE", plan: { relayOnly: true } },
    });
    const free = world({ mode: RelayAuthMode.INTRANET });
    expect(await free.service.holdsSessionsOf("c1")).toBe(false);
    const normal = world();
    normal.prisma.subscription.count.mockResolvedValue(1);
    expect(await normal.service.holdsSessionsOf("c1")).toBe(false);
  });

  it("records when an intranet is declared and when it ends", async () => {
    const w = world();
    await w.service.update({ mode: RelayAuthMode.INTRANET });
    expect(w.settings().intranetDeclaredAt).toBeInstanceOf(Date);
    await w.service.update({ mode: RelayAuthMode.AUTO });
    expect(w.settings().intranetEndedAt).toBeInstanceOf(Date);
    expect(await w.service.intranetHold()).toBe(true);
  });
});

describe("the unverified-account sweep (R3.8)", () => {
  it("deletes only unpaid, unverified relay accounts idle 30 days", async () => {
    const { service, prisma } = world();
    prisma.customer.findMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    prisma.customer.deleteMany.mockResolvedValueOnce({ count: 2 });
    expect(await service.sweepUnverified()).toBe(2);
    const where = prisma.customer.deleteMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      id: { in: ["a", "b"] },
      emailVerifiedAt: null,
      relayUnverifiedSince: { not: null, lt: expect.any(Date) },
      subscriptions: { none: {} },
      voucherRedemptions: { none: {} },
      transactions: { none: {} },
      invoices: { none: {} },
      sessions: { none: { lastUsedAt: { gte: expect.any(Date) } } },
    });
    const cutoff = where.relayUnverifiedSince.lt as Date;
    expect(Math.round((Date.now() - cutoff.getTime()) / DAY)).toBe(30);
  });

  it("is paused during a declared intranet", async () => {
    const { service, prisma } = world({ mode: RelayAuthMode.INTRANET });
    expect(await service.sweepUnverified()).toBe(0);
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
    expect(prisma.customer.deleteMany).not.toHaveBeenCalled();
  });
});

describe("the auto detector (R2.5)", () => {
  function dropping(w: ReturnType<typeof world>, now: number) {
    const end = bucketStart(now);
    for (let i = 1; i <= 3; i += 1) {
      w.buckets.set(end - i * BUCKET_MS, { start: new Date(end - i * BUCKET_MS), ir: 2, other: 190 });
      for (let d = 1; d <= 7; d += 1) {
        const at = end - d * DAY - i * BUCKET_MS;
        w.buckets.set(at, { start: new Date(at), ir: 100, other: 200 });
      }
    }
  }

  it("alerts the owner after half an hour and raises the caps after an hour, changing nothing customers see", async () => {
    const w = world();
    const t0 = Date.now();
    for (const minutes of [0, 10, 20, 30, 40, 50, 60, 70]) {
      const now = t0 + minutes * 60_000;
      dropping(w, now);
      await w.service.tickDetector(new Date(now));
    }
    const subjects = w.email.sendMail.mock.calls.map((c) => (c as unknown as [{ subject: string }])[0].subject);
    expect(subjects).toEqual([
      "[Neoxify] Iranian traffic has dropped: possible national intranet",
      "[Neoxify] Relay sign-up caps raised to the intranet tier",
    ]);
    expect(w.alerting.send).toHaveBeenCalledTimes(2);
    expect(w.settings().capsRaisedAt).toBeInstanceOf(Date);
    expect(w.settings().mode).toBe(RelayAuthMode.AUTO);
    expect(await w.service.publicStatus()).toEqual({ signup: true, intranet: false });
    expect(w.service.tierOf(w.settings() as never)).toBe("intranet");
  });

  it("does nothing outside AUTO", async () => {
    const w = world({ mode: RelayAuthMode.OFF });
    const now = Date.now();
    dropping(w, now);
    await w.service.tickDetector(new Date(now));
    await w.service.tickDetector(new Date(now + 3_600_000));
    expect(w.alerting.send).not.toHaveBeenCalled();
  });
});

describe("what the apps are told", () => {
  it("says whether sign-up is open and whether the owner declared an intranet (I4)", async () => {
    expect(await world().service.publicStatus()).toEqual({ signup: true, intranet: false });
    expect(await world({ mode: RelayAuthMode.OFF }).service.publicStatus()).toEqual({ signup: false, intranet: false });
    expect(await world({ mode: RelayAuthMode.INTRANET }).service.publicStatus()).toEqual({
      signup: true,
      intranet: true,
    });
  });
});
