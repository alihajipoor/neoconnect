/* eslint-disable @typescript-eslint/require-await -- stand-ins for the
   async Prisma client. */
import { DailyUsageService, REPORT_STATEMENT_TIMEOUT_MS } from "./daily-usage.service";

/** The read that filled the pool on 2026-11-14.
 *
 * One desktop client raced GET /customer/usage across a dozen API
 * addresses; 25 copies of the same heavy aggregate queued on a 5
 * connection pool shared with the agent streams, and 78 queries -- seven
 * agents' heartbeats among them -- timed out together.
 *
 * A unit test cannot show Postgres being starved. What it can show is the
 * two properties that make it impossible from here: identical concurrent
 * reads run the heavy statement once, and that statement never runs on
 * the main pool's client, only on the reporting one, under a statement
 * timeout. */
describe("DailyUsageService fan-out", () => {
  const CUSTOMER = "customer-1";

  function build() {
    let release!: (rows: unknown[]) => void;
    const gate = new Promise<unknown[]>((resolve) => (release = resolve));
    const main = {
      customer: { findUnique: jest.fn(async () => ({ createdAt: new Date("2025-01-01T00:00:00Z") })) },
      subscription: { findFirst: jest.fn() },
      $queryRaw: jest.fn(async () => []),
      $executeRawUnsafe: jest.fn(async () => 0),
      $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const reporting = {
      // Held open: a slow read still running while the race copies arrive.
      $queryRaw: jest.fn(() => gate),
      $executeRawUnsafe: jest.fn(async (sql: string) => (void sql, 0)),
      $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const service = new DailyUsageService(main as never, reporting as never);
    return { service, main, reporting, release };
  }

  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };

  it("runs the heavy statement once for 25 identical reads in flight, and answers all of them", async () => {
    const { service, reporting, release } = build();

    const reads = Array.from({ length: 25 }, () =>
      service.forCustomer(CUSTOMER, { days: 14, timeZone: "America/Los_Angeles" }),
    );
    await settle();
    expect(reporting.$queryRaw).toHaveBeenCalledTimes(1);

    release([]);
    const answers = await Promise.all(reads);
    expect(answers).toHaveLength(25);
    expect(new Set(answers.map((a) => a.from)).size).toBe(1);
  });

  it("never puts the heavy statement on the main pool, and bounds it with a statement timeout", async () => {
    const { service, main, reporting, release } = build();

    const read = service.forCustomer(CUSTOMER, { days: 14, timeZone: "UTC" });
    await settle();
    release([]);
    await read;

    expect(main.$queryRaw).not.toHaveBeenCalled();
    expect(main.$transaction).not.toHaveBeenCalled();
    expect(reporting.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL statement_timeout = ${REPORT_STATEMENT_TIMEOUT_MS}`);
    // The statement and its timeout in one transaction, so SET LOCAL
    // applies to it and to nothing else on that connection.
    expect(reporting.$transaction).toHaveBeenCalledTimes(1);
  });

  it("does not share a read between different windows or customers", async () => {
    const { service, reporting, release } = build();

    const reads = [
      service.forCustomer(CUSTOMER, { days: 14, timeZone: "UTC" }),
      service.forCustomer(CUSTOMER, { days: 7, timeZone: "UTC" }),
      service.forCustomer(CUSTOMER, { days: 14, timeZone: "Asia/Tehran" }),
      service.forCustomer("customer-2", { days: 14, timeZone: "UTC" }),
    ];
    await settle();
    expect(reporting.$queryRaw).toHaveBeenCalledTimes(4);
    release([]);
    await Promise.all(reads);
  });

  it("runs a fresh query once the shared one has finished, failed or not", async () => {
    const { service, reporting } = build();
    reporting.$queryRaw.mockImplementationOnce(() => Promise.reject(new Error("canceling statement due to statement timeout")));

    await expect(service.forCustomer(CUSTOMER, { days: 14, timeZone: "UTC" })).rejects.toThrow(/statement timeout/);
    reporting.$queryRaw.mockImplementationOnce(async () => []);
    await expect(service.forCustomer(CUSTOMER, { days: 14, timeZone: "UTC" })).resolves.toBeDefined();
    expect(reporting.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
