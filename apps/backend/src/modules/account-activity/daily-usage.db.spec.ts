import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { addDays, localDate, utcMidnight } from "./daily-usage";
import { DailyUsageService } from "./daily-usage.service";

/** The daily usage query against a real, migrated Postgres -- the one
 * thing the other specs cannot check, since they stand in for Prisma: the
 * raw SQL's column names, the types it hands back (bigint buckets, sums
 * past 2^53), and its time handling on a TIMESTAMP(3) column.
 *
 * Runs only with NEOXIFY_DB_SPECS=1, which CI sets for its own step after
 * applying every migration to the job's empty database (.github/workflows/
 * ci.yml). Never point it at a database that matters: it writes rows, and
 * removes only the ones it wrote. */

const enabled = process.env.NEOXIFY_DB_SPECS === "1";

(enabled ? describe : describe.skip)("daily usage against Postgres", () => {
  let prisma: PrismaClient;
  let service: DailyUsageService;
  const tag = randomUUID().slice(0, 8);
  const ids = { customer: "", stranger: "", plan: "", node: "", subscription: "", otherSubscription: "", strangerSubscription: "" };

  // Tehran is UTC+03:30 all year: its midnights are 20:30 UTC, half way
  // through an hour, which an hourly bucket would get wrong.
  const tz = "Asia/Tehran";
  const today = localDate(new Date(), tz);
  const yesterday = addDays(today, -1);
  const midnightYesterday = utcMidnight(yesterday) - 3.5 * 3_600_000;

  beforeAll(async () => {
    prisma = new PrismaClient();
    service = new DailyUsageService(prisma as never);
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    const customer = await prisma.customer.create({
      data: { email: `db-spec-${tag}@example.test`, createdAt: longAgo },
      select: { id: true },
    });
    const stranger = await prisma.customer.create({
      data: { email: `db-spec-${tag}-other@example.test`, createdAt: longAgo },
      select: { id: true },
    });
    const plan = await prisma.subscriptionPlan.create({
      data: { name: `db-spec-${tag}`, durationDays: 30, priceUsd: "1.00", protocolsAllowed: [], isPurchasable: false, isActive: false },
      select: { id: true },
    });
    const node = await prisma.node.create({
      data: { name: `db-spec-${tag}`, region: "test", publicIp: "192.0.2.10" },
      select: { id: true },
    });
    const subscription = (customerId: string) =>
      prisma.subscription.create({
        data: { customerId, planId: plan.id, expireAt: new Date(Date.now() + 86_400_000), createdAt: longAgo },
        select: { id: true },
      });
    const mine = await subscription(customer.id);
    const other = await subscription(customer.id);
    const strangers = await subscription(stranger.id);
    Object.assign(ids, {
      customer: customer.id,
      stranger: stranger.id,
      plan: plan.id,
      node: node.id,
      subscription: mine.id,
      otherSubscription: other.id,
      strangerSubscription: strangers.id,
    });

    const record = (subscriptionId: string, reportedAt: number, bytesUp: bigint, bytesDown: bigint) => ({
      subscriptionId,
      nodeId: node.id,
      periodStart: new Date(reportedAt - 30_000),
      periodEnd: new Date(reportedAt),
      reportedAt: new Date(reportedAt),
      bytesUp,
      bytesDown,
    });
    await prisma.usageRecord.createMany({
      data: [
        // A minute before yesterday's midnight: the day before.
        record(ids.subscription, midnightYesterday - 60_000, 1n, 10n),
        record(ids.subscription, midnightYesterday - 30_000, 2n, 20n),
        // A minute after it: yesterday, and past 2^53 together.
        record(ids.subscription, midnightYesterday + 60_000, 100n, 9_007_199_254_740_993n),
        record(ids.subscription, midnightYesterday + 90_000, 200n, 1n),
        // Another subscription of the same customer: not this one's.
        record(ids.otherSubscription, midnightYesterday + 60_000, 5_000n, 5_000n),
        // Another customer's: never this customer's.
        record(ids.strangerSubscription, midnightYesterday + 60_000, 70_000n, 70_000n),
      ],
    });
  }, 60_000);

  afterAll(async () => {
    const subscriptions = [ids.subscription, ids.otherSubscription, ids.strangerSubscription].filter(Boolean);
    await prisma.usageRecord.deleteMany({ where: { subscriptionId: { in: subscriptions } } });
    await prisma.subscription.deleteMany({ where: { id: { in: subscriptions } } });
    if (ids.plan) await prisma.subscriptionPlan.delete({ where: { id: ids.plan } });
    if (ids.node) await prisma.node.delete({ where: { id: ids.node } });
    const customers = [ids.customer, ids.stranger].filter(Boolean);
    await prisma.customer.deleteMany({ where: { id: { in: customers } } });
    await prisma?.$disconnect();
  });

  it("puts each side of Tehran's midnight on its own day, sums exactly, and reads only this subscription", async () => {
    const usage = await service.forSubscription(ids.customer, ids.subscription, { days: 3, timeZone: tz });

    expect(usage.to).toBe(today);
    expect(usage.days).toEqual([
      { date: addDays(today, -2), bytesUp: "3", bytesDown: "30" },
      { date: yesterday, bytesUp: "300", bytesDown: "9007199254740994" },
      { date: today, bytesUp: "0", bytesDown: "0" },
    ]);
  });

  it("drops what falls before the first day", async () => {
    const usage = await service.forSubscription(ids.customer, ids.subscription, { days: 2, timeZone: tz });
    expect(usage.days.map((d) => [d.date, d.bytesUp])).toEqual([
      [yesterday, "300"],
      [today, "0"],
    ]);
  });

  it("buckets the same rows by another zone's midnight", async () => {
    // 20:30 UTC is 22:30 in Berlin (or 21:30 in winter): all four rows
    // are on the same Berlin day.
    const usage = await service.forSubscription(ids.customer, ids.subscription, { days: 5, timeZone: "Europe/Berlin" });
    const nonEmpty = usage.days.filter((d) => d.bytesUp !== "0");
    expect(nonEmpty).toHaveLength(1);
    expect(nonEmpty[0]).toMatchObject({ bytesUp: "303", bytesDown: "9007199254741024" });
  });

  it("sums every subscription of the account, and no other account's", async () => {
    const usage = await service.forCustomer(ids.customer, { days: 3, timeZone: tz });
    expect(usage.subscriptionId).toBeNull();
    expect(usage.days).toEqual([
      { date: addDays(today, -2), bytesUp: "3", bytesDown: "30" },
      { date: yesterday, bytesUp: "5300", bytesDown: "9007199254745994" },
      { date: today, bytesUp: "0", bytesDown: "0" },
    ]);
  });
});
