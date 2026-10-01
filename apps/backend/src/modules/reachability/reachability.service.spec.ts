import { ReachabilityVerdict } from "@prisma/client";
import { ReachabilityService, medianOf } from "./reachability.service";
import type { ProbeOutcome, ProbeResult } from "./check-host.client";
import type { PrismaService } from "../../prisma/prisma.service";

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  vantage: "ir1",
  asn: "AS47430",
  city: "Tehran",
  ok: true,
  latencyMs: 70,
  error: null,
  ...over,
});

const outcome = (results: ProbeResult[], requested = 8): ProbeOutcome => ({ results, requested });

const config = (over: Record<string, unknown> = {}) => ({
  get: (key: string) =>
    ({
      "reachability.enabled": true,
      "reachability.country": "ir",
      "reachability.port": 443,
      "reachability.failuresBeforeAlert": 2,
      "reachability.retentionDays": 30,
      ...over,
    })[key],
});

/** A service over fakes, returning the mocks so a test can assert on
 * what reached the database and on what was mailed. */
const build = (over: Record<string, unknown> = {}) => {
  const checkCreate = jest.fn().mockResolvedValue({ checkedAt: new Date() });
  const checkFindMany = jest.fn().mockResolvedValue([]);
  const alertFindFirst = jest.fn().mockResolvedValue(null);
  const alertCreate = jest.fn().mockResolvedValue({ id: "alert-1" });
  const alertUpdate = jest.fn().mockResolvedValue({});
  const sendMail = jest.fn().mockResolvedValue(true);
  const alertingSend = jest.fn().mockResolvedValue(undefined);
  const tcpCheck = jest.fn();
  const vantagesIn = jest.fn().mockResolvedValue(["ir1", "ir2", "ir3", "ir4"]);

  const prisma = {
    node: { findMany: jest.fn().mockResolvedValue([]) },
    nodeReachabilityCheck: {
      create: checkCreate,
      findMany: checkFindMany,
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    nodeReachabilityAlert: {
      findFirst: alertFindFirst,
      create: alertCreate,
      update: alertUpdate,
    },
    adminUser: { findMany: jest.fn().mockResolvedValue([{ email: "ops@example.com" }]) },
  };

  const service = new ReachabilityService(
    prisma as unknown as PrismaService,
    config(over) as never,
    { tcpCheck, vantagesIn } as never,
    { sendMail } as never,
    { send: alertingSend } as never,
  );

  return {
    service,
    prisma,
    checkCreate,
    checkFindMany,
    alertFindFirst,
    alertCreate,
    alertUpdate,
    sendMail,
    alertingSend,
    tcpCheck,
  };
};

describe("ReachabilityService.verdictFor", () => {
  /** The failure mode this whole design exists to avoid. When check-host
   * is down or rate-limits us, every node returns nothing at once.
   * Calling that UNREACHABLE would email the operator that the entire
   * fleet is filtered because a third party had a bad minute. */
  it("is INCONCLUSIVE when the prober returned nothing", () => {
    const { service } = build();
    expect(service.verdictFor(outcome([]))).toBe(ReachabilityVerdict.INCONCLUSIVE);
  });

  /** One probe agreeing with itself is not evidence. */
  it("is INCONCLUSIVE on a single answer, even a failing one", () => {
    const { service } = build();
    expect(service.verdictFor(outcome([probe({ ok: false })]))).toBe(
      ReachabilityVerdict.INCONCLUSIVE,
    );
  });

  it("is UNREACHABLE when every answering vantage failed", () => {
    const { service } = build();
    const results = [probe({ ok: false }), probe({ vantage: "ir2", ok: false })];
    expect(service.verdictFor(outcome(results))).toBe(ReachabilityVerdict.UNREACHABLE);
  });

  it("is REACHABLE at half, which is the healthy threshold", () => {
    const { service } = build();
    const results = [probe(), probe({ vantage: "ir2", ok: false })];
    expect(service.verdictFor(outcome(results))).toBe(ReachabilityVerdict.REACHABLE);
  });

  /** Iranian operators filter independently, so one blocked ASN out of
   * four is the normal shape of a partial block -- visible, but not an
   * alert. */
  it("is DEGRADED when a minority still connects", () => {
    const { service } = build();
    const results = [
      probe(),
      probe({ vantage: "ir2", ok: false }),
      probe({ vantage: "ir3", ok: false }),
      probe({ vantage: "ir4", ok: false }),
    ];
    expect(service.verdictFor(outcome(results))).toBe(ReachabilityVerdict.DEGRADED);
  });
});

describe("ReachabilityService alerting", () => {
  const node = { id: "n1", name: "turkey-1", publicIp: "203.0.113.10" };

  const runOneNode = async (t: ReturnType<typeof build>, results: ProbeResult[]) => {
    t.prisma.node.findMany.mockResolvedValue([node]);
    t.tcpCheck.mockResolvedValue(outcome(results, 4));
    return t.service.runCycle();
  };

  const allFailing = [
    probe({ ok: false }),
    probe({ vantage: "ir2", ok: false }),
    probe({ vantage: "ir3", ok: false }),
  ];

  it("stays quiet on the first failing cycle", async () => {
    const t = build();
    t.checkFindMany.mockResolvedValue([{ verdict: ReachabilityVerdict.UNREACHABLE }]);
    await runOneNode(t, allFailing);
    expect(t.alertCreate).not.toHaveBeenCalled();
    expect(t.sendMail).not.toHaveBeenCalled();
  });

  it("alerts once the streak reaches the threshold", async () => {
    const t = build();
    t.checkFindMany.mockResolvedValue([
      { verdict: ReachabilityVerdict.UNREACHABLE },
      { verdict: ReachabilityVerdict.UNREACHABLE },
    ]);
    await runOneNode(t, allFailing);
    expect(t.alertCreate).toHaveBeenCalledTimes(1);
    expect(t.sendMail).toHaveBeenCalledTimes(1);
    expect(t.sendMail.mock.calls[0][0].subject).toContain("turkey-1");
  });

  /** Without this the operator gets the same mail every half hour until
   * they fix it, which is how people learn to filter the alerts. */
  it("does not alert again while the incident is open", async () => {
    const t = build();
    t.alertFindFirst.mockResolvedValue({ id: "alert-1", openedAt: new Date() });
    t.checkFindMany.mockResolvedValue([
      { verdict: ReachabilityVerdict.UNREACHABLE },
      { verdict: ReachabilityVerdict.UNREACHABLE },
      { verdict: ReachabilityVerdict.UNREACHABLE },
    ]);
    await runOneNode(t, allFailing);
    expect(t.alertCreate).not.toHaveBeenCalled();
    expect(t.sendMail).not.toHaveBeenCalled();
  });

  /** An INCONCLUSIVE cycle is the absence of information. Resolving on
   * it would tell the operator a node recovered because the prober went
   * down -- the most dangerous wrong answer this can give. */
  it("does not resolve an open incident on an INCONCLUSIVE cycle", async () => {
    const t = build();
    t.alertFindFirst.mockResolvedValue({ id: "alert-1", openedAt: new Date() });
    await runOneNode(t, []);
    expect(t.alertUpdate).not.toHaveBeenCalled();
    expect(t.sendMail).not.toHaveBeenCalled();
  });

  it("resolves and mails when the node answers again", async () => {
    const t = build();
    const openedAt = new Date(Date.now() - 90 * 60_000);
    t.alertFindFirst.mockResolvedValue({ id: "alert-1", openedAt });
    await runOneNode(t, [probe(), probe({ vantage: "ir2" })]);
    expect(t.alertUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "alert-1" } }),
    );
    expect(t.sendMail.mock.calls[0][0].subject).toContain("reachable");
  });

  /** A node blocked on one operator is real and worth seeing, but it is
   * also an ordinary Tuesday in Iran. Paging on it would mean paging
   * most days. */
  it("does not alert on DEGRADED", async () => {
    const t = build();
    t.checkFindMany.mockResolvedValue([
      { verdict: ReachabilityVerdict.DEGRADED },
      { verdict: ReachabilityVerdict.DEGRADED },
    ]);
    await runOneNode(t, [
      probe(),
      probe({ vantage: "ir2", ok: false }),
      probe({ vantage: "ir3", ok: false }),
      probe({ vantage: "ir4", ok: false }),
    ]);
    expect(t.alertCreate).not.toHaveBeenCalled();
  });

  /** A prober hiccup inside a genuine outage should neither mask it nor
   * manufacture one: the INCONCLUSIVE row is skipped, and the real
   * failures either side of it still count as consecutive. */
  it("ignores INCONCLUSIVE rows when counting the streak", async () => {
    const t = build();
    t.checkFindMany.mockResolvedValue([
      { verdict: ReachabilityVerdict.UNREACHABLE },
      { verdict: ReachabilityVerdict.INCONCLUSIVE },
      { verdict: ReachabilityVerdict.UNREACHABLE },
    ]);
    await runOneNode(t, allFailing);
    expect(t.alertCreate).toHaveBeenCalledTimes(1);
  });

  /** A streak broken by a healthy cycle is not a streak. */
  it("stops counting at the first healthy cycle", async () => {
    const t = build();
    t.checkFindMany.mockResolvedValue([
      { verdict: ReachabilityVerdict.UNREACHABLE },
      { verdict: ReachabilityVerdict.REACHABLE },
      { verdict: ReachabilityVerdict.UNREACHABLE },
    ]);
    await runOneNode(t, allFailing);
    expect(t.alertCreate).not.toHaveBeenCalled();
  });

  /** An alert raised but never delivered must not look, in the table,
   * like one the operator simply has not acted on yet. */
  it("records a delivery failure on the incident", async () => {
    const t = build();
    t.sendMail.mockResolvedValue(false);
    t.checkFindMany.mockResolvedValue([
      { verdict: ReachabilityVerdict.UNREACHABLE },
      { verdict: ReachabilityVerdict.UNREACHABLE },
    ]);
    await runOneNode(t, allFailing);
    expect(t.alertUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notifiedAt: null, notifyError: expect.any(String) }),
      }),
    );
  });

  /** One node failing must not abandon the rest of the fleet. */
  it("keeps probing after one node throws", async () => {
    const t = build();
    t.prisma.node.findMany.mockResolvedValue([node, { ...node, id: "n2", name: "germany-1" }]);
    t.tcpCheck
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(outcome([probe(), probe({ vantage: "ir2" })], 4));
    const summaries = await t.service.runCycle();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].nodeName).toBe("germany-1");
  });

  /** No vantages means no measurement; inventing verdicts would be
   * worse than recording nothing. */
  it("records nothing when the country has no vantage points", async () => {
    const t = build();
    t.prisma.node.findMany.mockResolvedValue([node]);
    (t.service as unknown as { checkHost: { vantagesIn: jest.Mock } }).checkHost.vantagesIn =
      jest.fn().mockResolvedValue([]);
    await t.service.runCycle();
    expect(t.checkCreate).not.toHaveBeenCalled();
  });

  it("probes nothing at all when disabled", async () => {
    const t = build({ "reachability.enabled": false });
    t.prisma.node.findMany.mockResolvedValue([node]);
    await expect(t.service.runCycle()).resolves.toEqual([]);
    expect(t.checkCreate).not.toHaveBeenCalled();
  });
});

describe("medianOf", () => {
  it("is null with nothing to average", () => {
    expect(medianOf([])).toBeNull();
  });

  /** Median, not mean: one vantage behind terrible transit should not
   * drag the number for the other seven. */
  it("is unmoved by a single outlier", () => {
    // Even count averages the middle pair: (72 + 75) / 2 = 73.5 -> 74.
    // The 9000ms outlier moves it by one millisecond; a mean would have
    // put it past 2000.
    expect(medianOf([70, 72, 75, 9000])).toBe(74);
    expect(medianOf([70, 72, 75])).toBe(72);
  });
});
