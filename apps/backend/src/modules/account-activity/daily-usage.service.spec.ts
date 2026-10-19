/* eslint-disable @typescript-eslint/require-await -- the stand-ins below
   match the async signatures of the Prisma client they replace. */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { DailyUsageService } from "./daily-usage.service";

/** The daily usage history over a stand-in Prisma: ownership, the time
 * zone, the window it reads, and what it makes of the database's rows.
 * The SQL itself meets a real Postgres in daily-usage.db.spec.ts. */

const CUSTOMER = "customer-1";
const SUB = "11111111-1111-4111-8111-111111111111";

function build(opts: { createdAt?: Date; rows?: { bucket: bigint | number | string; up: string | null; down: string | null }[] } = {}) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const prisma = {
    subscription: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; customerId: string } }) =>
        where.id === SUB && where.customerId === CUSTOMER
          ? { id: SUB, createdAt: opts.createdAt ?? new Date("2025-01-01T00:00:00Z") }
          : null,
      ),
    },
    customer: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === CUSTOMER ? { createdAt: opts.createdAt ?? new Date("2025-01-01T00:00:00Z") } : null,
      ),
    },
    // Flattened as Prisma flattens it: nested fragments inline, their
    // values in order.
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...(values as Prisma.Sql[]));
      queries.push({ sql: sql.sql, values: sql.values });
      return opts.rows ?? [];
    }),
  };
  return { service: new DailyUsageService(prisma as never), prisma, queries };
}

describe("DailyUsageService", () => {
  // 00:30 on 20 October in Tehran.
  beforeEach(() => jest.useFakeTimers({ now: new Date("2026-10-19T21:00:00Z") }));
  afterEach(() => jest.useRealTimers());

  it("returns one total per day in the caller's zone, today last, from the database's quarter hours", async () => {
    const { service } = build({
      rows: [
        { bucket: BigInt(Date.parse("2026-10-13T20:00:00Z") / 1000), up: "7", down: "7" }, // the 13th: before the window
        { bucket: BigInt(Date.parse("2026-10-19T20:15:00Z") / 1000), up: "100", down: "1000" }, // 23:45 on the 19th
        { bucket: BigInt(Date.parse("2026-10-19T20:30:00Z") / 1000), up: "5", down: "50" }, // 00:00 on the 20th
      ],
    });

    const usage = await service.forSubscription(CUSTOMER, SUB, { days: 7, timeZone: "Asia/Tehran" });

    expect(usage).toEqual({
      subscriptionId: SUB,
      timeZone: "Asia/Tehran",
      from: "2026-10-14",
      to: "2026-10-20",
      asOf: "2026-10-19T21:00:00.000Z",
      days: [
        { date: "2026-10-14", bytesUp: "0", bytesDown: "0" },
        { date: "2026-10-15", bytesUp: "0", bytesDown: "0" },
        { date: "2026-10-16", bytesUp: "0", bytesDown: "0" },
        { date: "2026-10-17", bytesUp: "0", bytesDown: "0" },
        { date: "2026-10-18", bytesUp: "0", bytesDown: "0" },
        { date: "2026-10-19", bytesUp: "100", bytesDown: "1000" },
        { date: "2026-10-20", bytesUp: "5", bytesDown: "50" },
      ],
    });
  });

  it("reads from before the first day's local midnight, scoped to the subscription, up to now", async () => {
    const { service, queries } = build();
    await service.forSubscription(CUSTOMER, SUB, { days: 7, timeZone: "Asia/Tehran" });

    expect(queries).toHaveLength(1);
    const { sql, values } = queries[0];
    expect(sql).toContain('FROM "usage_records"');
    expect(sql).toContain('"subscriptionId" = ?');
    const strings = values.filter((v): v is string => typeof v === "string");
    expect(strings[0]).toBe(SUB);
    const [since, until] = strings.slice(1).map((v) => Date.parse(v));
    // Midnight of the 14th in Tehran is 20:30 UTC on the 13th.
    expect(since).toBeLessThanOrEqual(Date.parse("2026-10-13T20:30:00Z"));
    expect(until).toBeGreaterThan(Date.parse("2026-10-19T21:00:00Z"));
  });

  it("starts no earlier than the day the subscription was created", async () => {
    const { service } = build({ createdAt: new Date("2026-10-18T10:00:00Z") });
    const usage = await service.forSubscription(CUSTOMER, SUB, { days: 30, timeZone: "Asia/Tehran" });
    expect(usage.from).toBe("2026-10-18");
    expect(usage.days.map((d) => d.date)).toEqual(["2026-10-18", "2026-10-19", "2026-10-20"]);
  });

  it("defaults to 30 days in UTC", async () => {
    const { service } = build();
    const usage = await service.forSubscription(CUSTOMER, SUB);
    expect(usage.timeZone).toBe("UTC");
    expect(usage.to).toBe("2026-10-19");
    expect(usage.days).toHaveLength(30);
  });

  it("reads a sum the database returned as null as nothing, never as a number it made up", async () => {
    const { service } = build({ rows: [{ bucket: "1792443600", up: null, down: null }] });
    const usage = await service.forSubscription(CUSTOMER, SUB, { days: 1, timeZone: "UTC" });
    expect(usage.days).toEqual([{ date: "2026-10-19", bytesUp: "0", bytesDown: "0" }]);
  });

  it("answers 404 for another customer's subscription, without reading its usage", async () => {
    const { service, prisma } = build();
    await expect(service.forSubscription("customer-2", SUB, { days: 7 })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("answers 400 UNKNOWN_TIME_ZONE for a zone that is not one, before touching the database", async () => {
    const { service, prisma } = build();
    const err = await service
      .forSubscription(CUSTOMER, SUB, { days: 7, timeZone: "Mars/Olympus_Mons" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: "UNKNOWN_TIME_ZONE" });
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
  });

  describe("for the whole account", () => {
    it("reads every subscription of this customer, and only this customer's", async () => {
      const { service, queries } = build({
        rows: [{ bucket: BigInt(Date.parse("2026-10-19T20:30:00Z") / 1000), up: "5", down: "50" }],
      });

      const usage = await service.forCustomer(CUSTOMER, { days: 2, timeZone: "Asia/Tehran" });

      expect(usage).toMatchObject({
        subscriptionId: null,
        from: "2026-10-19",
        to: "2026-10-20",
        days: [
          { date: "2026-10-19", bytesUp: "0", bytesDown: "0" },
          { date: "2026-10-20", bytesUp: "5", bytesDown: "50" },
        ],
      });
      expect(queries[0].sql).toContain('"subscriptionId" IN (SELECT "id" FROM "subscriptions" WHERE "customerId" = ?)');
      expect(queries[0].values[0]).toBe(CUSTOMER);
    });

    it("starts no earlier than the day the account was created", async () => {
      const { service } = build({ createdAt: new Date("2026-10-19T08:00:00Z") });
      const usage = await service.forCustomer(CUSTOMER, { days: 30, timeZone: "Asia/Tehran" });
      expect(usage.days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20"]);
    });

    it("answers 404 for an account that is gone", async () => {
      const { service, prisma } = build();
      await expect(service.forCustomer("customer-gone")).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
