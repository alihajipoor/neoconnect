import { ClientAttemptKind, ClientAttemptOutcome, Prisma } from "@prisma/client";
import {
  ClientAttemptsService,
  RETENTION_DAYS,
  plausibleOccurredAt,
  recordedPlatform,
} from "./client-attempts.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { ReportAttemptDto } from "./dto/report-attempt.dto";
import type { NetworkIdentityService } from "../network-identity/network-identity.service";

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
  // Vouches for exactly one token, as the real attestor vouches only for
  // its own signatures.
  const identity = { verify: (token?: string) => (token === "signed-for-64500" ? 64500 : null) };
  const service = new ClientAttemptsService(
    { clientAttempt: { create, deleteMany, findMany, groupBy } } as unknown as PrismaService,
    identity as unknown as NetworkIdentityService,
  );
  return { service, create, deleteMany, findMany, groupBy };
};

/** The per-ISP tags count people by network, so the network on a row has
 * to be one the server itself vouched for. */
describe("ClientAttemptsService.record network", () => {
  it("stores the ASN a valid attestation vouches for", async () => {
    const { service, create } = build();
    await service.record(report({ network: "signed-for-64500" }), {});
    expect(create.mock.calls[0][0].data.asn).toBe(64500);
  });

  /** A forged, expired or foreign token is dropped, and the report with
   * it is kept -- the failure it describes is still worth having. */
  it("keeps the report but not the network when the token does not verify", async () => {
    const { service, create } = build();
    await service.record(report({ network: "made-up" }), { ip: "198.51.100.7" });
    const data = create.mock.calls[0][0].data;
    expect(data.asn).toBeNull();
    expect(data.outcome).toBe(ClientAttemptOutcome.NOT_CARRYING_TRAFFIC);
  });

  it("keeps a session length only on a SESSION report", async () => {
    const { service, create } = build();
    await service.record(
      report({ kind: ClientAttemptKind.SESSION, outcome: ClientAttemptOutcome.SUCCESS, sessionSeconds: 900 }),
      {},
    );
    await service.record(report({ sessionSeconds: 900 }), {});
    expect(create.mock.calls[0][0].data.sessionSeconds).toBe(900);
    expect(create.mock.calls[1][0].data.sessionSeconds).toBeNull();
  });
});

/** Mobile up to 0.2.21 called anything that was not Android "windows".
 * The rows that produced were iOS, and read as a Windows problem. */
describe("recordedPlatform", () => {
  it("files the iOS-era mobile builds' 'windows' as an inference about iOS", () => {
    for (const v of ["0.2.18", "0.2.19", "0.2.20", "0.2.21"]) {
      expect(recordedPlatform("windows", v)).toBe("ios-inferred");
    }
  });

  /** No iOS build existed below 0.2.18, so it cannot be called iOS --
   * only "the mobile app, not on Android". */
  it("does not claim iOS for a mobile version that never had an iOS build", () => {
    expect(recordedPlatform("windows", "0.2.17")).toBe("mobile-inferred");
    expect(recordedPlatform("windows", "0.2.5")).toBe("mobile-inferred");
  });

  /** 0.2.22 fixed the guess, so from there "windows" is what it says. */
  it("believes the fixed builds", () => {
    expect(recordedPlatform("windows", "0.2.22")).toBe("windows");
    expect(recordedPlatform("windows", "0.2.30")).toBe("windows");
  });

  /** The real Windows client, and every label the guess got right. */
  it("leaves the desktop client and correctly labelled reports alone", () => {
    expect(recordedPlatform("windows", "0.9.42")).toBe("windows");
    expect(recordedPlatform("windows", "0.8.9")).toBe("windows");
    expect(recordedPlatform("android", "0.2.20")).toBe("android");
    expect(recordedPlatform("ios", "0.2.22")).toBe("ios");
    expect(recordedPlatform("windows", "unknown")).toBe("windows");
    expect(recordedPlatform("windows", "0.2.20-rc1")).toBe("windows");
  });

  it("is what reaches the database", async () => {
    const { service, create } = build();
    await service.record(report({ platform: "windows", appVersion: "0.2.20" }), {});
    await service.record(report({ platform: "windows", appVersion: "0.9.42" }), {});
    expect(create.mock.calls[0][0].data.platform).toBe("ios-inferred");
    expect(create.mock.calls[1][0].data.platform).toBe("windows");
  });
});

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
    const after = Date.now();
    const cutoff: number = (deleteMany.mock.calls[0][0].where.createdAt.lt as Date).getTime();

    // The service reads its own clock somewhere between these two, so
    // the cutoff is bracketed rather than compared to a single instant.
    // An earlier version asserted against `before` alone, which required
    // the call to take exactly zero milliseconds -- it passed alone and
    // failed inside the full suite.
    const window = RETENTION_DAYS * 86_400_000;
    expect(cutoff).toBeGreaterThanOrEqual(before - window);
    expect(cutoff).toBeLessThanOrEqual(after - window);
  });
});
