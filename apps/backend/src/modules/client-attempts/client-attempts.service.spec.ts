import { ClientAttemptKind, ClientAttemptOutcome, Prisma } from "@prisma/client";
import {
  ClientAttemptsService,
  RETENTION_DAYS,
  plausibleOccurredAt,
} from "./client-attempts.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { ReportAttemptDto } from "./dto/report-attempt.dto";

const report = (over: Partial<ReportAttemptDto> = {}): ReportAttemptDto => ({
  kind: ClientAttemptKind.CONNECT,
  outcome: ClientAttemptOutcome.NOT_CARRYING_TRAFFIC,
  platform: "windows",
  appVersion: "0.8.9",
  ...over,
});

/** Builds a service over a fake Prisma, returning the mocks so a test can
 * assert on what reached the database. */
const build = () => {
  const create = jest.fn().mockResolvedValue({});
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const findMany = jest.fn().mockResolvedValue([]);
  const groupBy = jest.fn().mockResolvedValue([]);
  const service = new ClientAttemptsService({
    clientAttempt: { create, deleteMany, findMany, groupBy },
  } as unknown as PrismaService);
  return { service, create, deleteMany, findMany, groupBy };
};

describe("ClientAttemptsService.record", () => {
  /** The whole point of this endpoint is a client that is already
   * failing. If recording its complaint threw, the app would surface a
   * second error on top of the one it was reporting -- so a lost report
   * has to be strictly better than a raised exception. */
  it("does not throw when the write fails", async () => {
    const { service, create } = build();
    create.mockRejectedValue(new Error("database is on fire"));
    await expect(service.record(report(), {})).resolves.toBeUndefined();
  });

  /** A customer can be deleted from the panel while an access token
   * naming them is still inside its 15 minutes, and the foreign key then
   * rejects the entire row. Attribution is the disposable part. */
  it("retries without the customer when a stale id breaks the insert", async () => {
    const { service, create } = build();
    create.mockRejectedValueOnce(new Error("foreign key constraint failed"));
    await service.record(report(), { customerId: "gone", ip: "1.2.3.4" });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].data.customerId).toBe("gone");
    const retried = create.mock.calls[1][0].data;
    expect(retried.customerId).toBeNull();
    // The rest of the report has to survive the retry -- dropping the
    // reason and the IP would leave a row that says nothing.
    expect(retried.ip).toBe("1.2.3.4");
    expect(retried.outcome).toBe(ClientAttemptOutcome.NOT_CARRYING_TRAFFIC);
  });

  it("does not retry when there was no customer id to blame", async () => {
    const { service, create } = build();
    create.mockRejectedValue(new Error("database is on fire"));
    await service.record(report(), { ip: "1.2.3.4" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  /** This endpoint takes anonymous submissions, so an array is the easy
   * way to make one row enormous. A real ladder is five rungs. */
  it("caps the ladder a client can submit", async () => {
    const { service, create } = build();
    const attempts = Array.from({ length: 50 }, (_, i) => ({ protocol: `p${i}`, result: "failed" }));
    await service.record(report({ attempts }), {});
    expect(create.mock.calls[0][0].data.attemptsJson).toHaveLength(12);
  });

  /** Prisma treats `null` on a Json column as "SQL NULL vs JSON null,
   * pick one" and errors if given a bare null, so an absent ladder has
   * to be written as JsonNull explicitly. */
  it("writes an absent ladder as JSON null rather than an empty array", async () => {
    const { service, create } = build();
    await service.record(report(), {});
    expect(create.mock.calls[0][0].data.attemptsJson).toBe(Prisma.JsonNull);
  });
});

/** The bucket this whole endpoint exists for -- "could not reach the
 * control plane" -- can only ever be reported late, because the client
 * had no way to report it at the time. Stamping those with the arrival
 * time would date an outage to the moment somebody got back online. */
describe("plausibleOccurredAt", () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  it("keeps a report that was queued earlier", () => {
    expect(plausibleOccurredAt(at(-3 * 3_600_000), now)?.getTime()).toBe(now - 3 * 3_600_000);
  });

  it("keeps nothing when the client did not say", () => {
    expect(plausibleOccurredAt(undefined, now)).toBeNull();
  });

  /** Clock skew of a few minutes is ordinary; a report from next week is
   * a broken clock or an invention, and showing it would put a row above
   * everything real forever. */
  it("allows slight skew but rejects the future", () => {
    expect(plausibleOccurredAt(at(60_000), now)).not.toBeNull();
    expect(plausibleOccurredAt(at(60 * 60_000), now)).toBeNull();
  });

  /** Older than the row will ever live is not a late report, it is
   * nonsense -- and the retention window is the honest bound on it. */
  it("rejects something older than the retention window", () => {
    expect(plausibleOccurredAt(at(-(RETENTION_DAYS + 1) * 86_400_000), now)).toBeNull();
  });

  it("rejects a value that is not a date at all", () => {
    expect(plausibleOccurredAt("yesterday-ish", now)).toBeNull();
  });
});

describe("ClientAttemptsService.list", () => {
  /** The default view. A list dominated by successes buries the thing
   * being looked for, which is the failures. */
  it("filters to failures without excluding any particular one", async () => {
    const { service, findMany } = build();
    await service.list({ failuresOnly: true });
    expect(findMany.mock.calls[0][0].where.outcome).toEqual({
      not: ClientAttemptOutcome.SUCCESS,
    });
  });

  /** An unauthenticated table can grow fast, and `take=100000` from the
   * panel would be a self-inflicted outage. */
  it("clamps how much can be asked for at once", async () => {
    const { service, findMany } = build();
    await service.list({ take: 100_000 });
    expect(findMany.mock.calls[0][0].take).toBe(500);
  });

  it("defaults to a page rather than everything", async () => {
    const { service, findMany } = build();
    await service.list({});
    expect(findMany.mock.calls[0][0].take).toBe(100);
    expect(findMany.mock.calls[0][0].where).toEqual({});
  });
});

describe("ClientAttemptsService.prune", () => {
  /** The sweep is the only thing that actually enforces the retention
   * promise on a table of IP addresses belonging to people in a country
   * where holding them is dangerous. */
  it("deletes strictly older than the retention window", async () => {
    const { service, deleteMany } = build();
    const before = Date.now();
    await service.prune();
    const cutoff: Date = deleteMany.mock.calls[0][0].where.createdAt.lt;

    const age = before - cutoff.getTime();
    expect(age).toBeGreaterThanOrEqual(RETENTION_DAYS * 86_400_000);
    // Allow for the milliseconds the call itself takes, nothing more --
    // a window that quietly drifted to 15 days should fail here.
    expect(age).toBeLessThan(RETENTION_DAYS * 86_400_000 + 5_000);
  });
});
