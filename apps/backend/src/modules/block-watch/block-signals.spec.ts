import {
  assess,
  clientFamily,
  DEFAULT_TUNING,
  parseTuning,
  probeFamily,
  recoveredFamilies,
  trafficFamily,
  vantageNetworks,
  type FamilyResult,
  type NodeDial,
  type ProbeCheck,
} from "./block-signals";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-19T12:00:00Z");

/** Customers dialling `asn` in the last hour; `carried` of them got through. */
function recent(asn: number, total: number, carried: number, prefix = "r", protocol = "VLESS"): NodeDial[] {
  return Array.from({ length: total }, (_, i) => {
    const at = NOW - 30 * MIN - i * MIN;
    return { customerId: `${prefix}${asn}-${i}`, asn, carried: i < carried, at, arrived: at, protocol };
  });
}

/** The ids of `n` of those customers, as ones the server had carried
 * traffic for before. */
function usedBefore(asn: number, n: number, prefix = "r"): Set<string> {
  return new Set(Array.from({ length: n }, (_, i) => `${prefix}${asn}-${i}`));
}

describe("parseTuning", () => {
  it("is the fallbacks when blank", () => {
    expect(parseTuning("")).toEqual({ tuning: DEFAULT_TUNING, problems: [] });
    expect(parseTuning(undefined).tuning).toEqual(DEFAULT_TUNING);
  });

  it("reads durations, shares and counts, separated by commas or spaces", () => {
    const { tuning, problems } = parseTuning("recentWindow=90m, maxCarriedShare=0.2 probeStreak=3;baselineWindow=10d");
    expect(problems).toEqual([]);
    expect(tuning).toMatchObject({
      recentWindow: 90 * MIN,
      maxCarriedShare: 0.2,
      probeStreak: 3,
      baselineWindow: 10 * DAY,
    });
  });

  it("keeps the fallback for anything it cannot read, and says so", () => {
    const { tuning, problems } = parseTuning("maxCarriedShare=1.5,probeStreak=0,recentWindow=soon,nonsense=1");
    expect(tuning.maxCarriedShare).toBe(DEFAULT_TUNING.maxCarriedShare);
    expect(tuning.probeStreak).toBe(DEFAULT_TUNING.probeStreak);
    expect(tuning.recentWindow).toBe(DEFAULT_TUNING.recentWindow);
    expect(problems).toHaveLength(4);
    expect(problems.join(" ")).toContain('unknown setting "nonsense"');
  });

  it("refuses windows in an order that makes no sense", () => {
    expect(parseTuning("trafficWindow=1d").tuning.trafficWindow).toBe(DEFAULT_TUNING.trafficWindow);
    expect(parseTuning("baselineWindow=2h").tuning.baselineWindow).toBe(DEFAULT_TUNING.baselineWindow);
    const crossed = parseTuning("trafficCliffShare=0.8,trafficRecoveryShare=0.5");
    expect(crossed.problems).toHaveLength(1);
    expect(crossed.tuning.trafficRecoveryShare).toBeGreaterThan(crossed.tuning.trafficCliffShare);
  });
});

describe("clientFamily", () => {
  it("never fires from one customer, however many reports", () => {
    const one: NodeDial[] = Array.from({ length: 12 }, (_, i) => ({
      customerId: "c1",
      asn: 64500,
      carried: false,
      at: NOW - i * MIN,
      arrived: NOW - i * MIN,
      protocol: "VLESS",
    }));
    const result = clientFamily(one, NOW, 0, new Set(["c1"]));
    expect(result.firing).toBe(false);
    expect(result.networks[0]).toMatchObject({ asn: 64500, tried: 1, failed: 1 });
  });

  it("fires when several customers it carried for before get nothing through", () => {
    const result = clientFamily(recent(64500, 4, 0), NOW, 0, usedBefore(64500, 4), DEFAULT_TUNING, {
      orgOf: () => "Example Carrier",
    });
    expect(result.firing).toBe(true);
    expect(result.networks[0]).toMatchObject({ asn: 64500, org: "Example Carrier", tried: 4, failed: 4, baseline: 4, failing: true });
    expect(result.summary).toContain("AS64500 (Example Carrier)");
    expect(result.onset).toBe(NOW - 33 * MIN);
  });

  it("does not call it a new block when the server never carried for these people", () => {
    // Accounts that never used the server cannot make it look blocked.
    const result = clientFamily(recent(64500, 6, 0), NOW, 0, usedBefore(64500, 1));
    expect(result.firing).toBe(false);
    expect(result.networks[0]).toMatchObject({ baseline: 1, failing: false });
  });

  it("does not fire while a fair share still gets through", () => {
    // 2 of 6 carried is a third: a partial problem, not a block.
    expect(clientFamily(recent(64500, 6, 2), NOW, 0, usedBefore(64500, 6)).firing).toBe(false);
  });

  it("counts each customer by their latest dial: a retry that worked is a success", () => {
    const failedThenWorked: NodeDial[] = recent(64500, 4, 0).flatMap((d) => [
      d,
      { ...d, carried: true, at: d.at + MIN, arrived: d.arrived + MIN },
    ]);
    const result = clientFamily(failedThenWorked, NOW, 0, usedBefore(64500, 4));
    expect(result.firing).toBe(false);
    expect(result.networks[0]).toMatchObject({ tried: 4, failed: 0 });
  });

  it("orders one report's rungs by their place in the ladder", () => {
    const sameReport = recent(64500, 4, 0).flatMap((d) => [
      { ...d, carried: true, rung: 1 },
      { ...d, rung: 2 },
    ]);
    expect(clientFamily(sameReport, NOW, 0, usedBefore(64500, 4)).firing).toBe(true);
  });

  it("goes by arrival, not by a time the client claims", () => {
    // A failure that says it happened long ago but arrived now is not old;
    // one that arrived before the window is not recent, whatever it says.
    const backdated = recent(64500, 4, 0).map((d) => ({ ...d, at: NOW - 2 * HOUR, arrived: NOW - MIN }));
    const result = clientFamily(backdated, NOW, 0, usedBefore(64500, 4));
    expect(result.firing).toBe(true);
    expect(result.onset).toBe(NOW - MIN);
    const stale = recent(64500, 4, 0).map((d) => ({ ...d, arrived: NOW - 5 * HOUR }));
    expect(clientFamily(stale, NOW, 0, usedBefore(64500, 4)).networks).toHaveLength(0);
  });

  it("ignores everything before the owner's last answer", () => {
    expect(clientFamily(recent(64500, 4, 0), NOW, NOW - 10 * MIN, usedBefore(64500, 4)).firing).toBe(false);
  });

  it("is thin with too few customers to judge", () => {
    expect(clientFamily(recent(64500, 2, 0), NOW, 0, new Set()).thin).toBe(true);
    expect(clientFamily(recent(64500, 3, 3), NOW, 0, new Set()).thin).toBe(false);
  });

  it("names protocols that still carry for the failing networks", () => {
    const dials = [...recent(64500, 4, 0, "r", "VLESS"), ...recent(64500, 1, 1, "s", "TROJAN")];
    const result = clientFamily(dials, NOW, 0, usedBefore(64500, 4));
    expect(result.firing).toBe(true);
    expect(result.carriedProtocols).toEqual(["TROJAN"]);
    expect(result.failedProtocols).toEqual(["VLESS"]);
  });

  it("is healthy only when a network that had failed carries again", () => {
    const working = recent(64500, 4, 4);
    expect(clientFamily(working, NOW, 0, new Set()).healthy).toBe(false);
    expect(clientFamily(working, NOW, 0, new Set(), DEFAULT_TUNING, { failedAsns: [64501] }).healthy).toBe(false);
    const again = clientFamily(working, NOW, 0, new Set(), DEFAULT_TUNING, { failedAsns: [64500] });
    expect(again.healthy).toBe(true);
    expect(again.summary).toContain("carrying again");
    // One customer getting through is not a network carrying again.
    expect(clientFamily(recent(64500, 4, 1), NOW, 0, new Set(), DEFAULT_TUNING, { failedAsns: [64500] }).healthy).toBe(false);
  });
});

describe("trafficFamily", () => {
  const week = (n: number) => Array.from({ length: 7 }, () => n);

  it("fires on a cliff against the same hours on the days before", () => {
    const result = trafficFamily({ current: 2, baseline: week(14) });
    expect(result).toMatchObject({ firing: true, thin: false, healthy: false });
    expect(result.summary).toContain("usually 14");
  });

  it("does not fire on an ordinary dip, and is healthy near usual", () => {
    expect(trafficFamily({ current: 8, baseline: week(14) })).toMatchObject({ firing: false, healthy: false });
    expect(trafficFamily({ current: 12, baseline: week(14) })).toMatchObject({ firing: false, healthy: true });
  });

  it("says when the days compared are the ones before an incident", () => {
    expect(trafficFamily({ current: 2, baseline: week(14), beforeIncident: true }).summary).toContain("before this began");
  });

  it("is thin with too little history or too few users", () => {
    expect(trafficFamily({ current: 0, baseline: [14, 14, null, null, null, null, null] })).toMatchObject({
      firing: false,
      thin: true,
      healthy: false,
    });
    expect(trafficFamily({ current: 0, baseline: week(3) })).toMatchObject({ firing: false, thin: true });
    expect(trafficFamily(undefined)).toMatchObject({ firing: false, thin: true });
  });

  it("uses the median, so one busy day does not make an ordinary one a cliff", () => {
    expect(trafficFamily({ current: 5, baseline: [100, 8, 8, 9, 8, 7, 8] }).firing).toBe(false);
  });

  it("follows its settings", () => {
    const tuning = parseTuning("trafficCliffShare=0.6").tuning;
    expect(trafficFamily({ current: 8, baseline: week(14) }, tuning).firing).toBe(true);
  });
});

describe("probeFamily", () => {
  const check = (verdict: ProbeCheck["verdict"], minutesAgo: number, ok = verdict !== "UNREACHABLE"): ProbeCheck => ({
    verdict,
    checkedAt: NOW - minutesAgo * MIN,
    detail: [
      { vantage: "v1", asn: "AS64500", ok },
      { vantage: "v2", asn: "AS64501", ok },
    ],
  });

  it("fires on consecutive unreachable checks, with the first as its onset", () => {
    const result = probeFamily([check("UNREACHABLE", 5), check("UNREACHABLE", 35), check("REACHABLE", 65)], NOW, 0);
    expect(result).toMatchObject({ firing: true, onset: NOW - 35 * MIN, tcpOpen: false, healthy: false });
    expect(result.networks.map((n) => n.asn)).toEqual([64500, 64501]);
  });

  it("does not fire on a single unreachable check", () => {
    expect(probeFamily([check("UNREACHABLE", 5), check("REACHABLE", 35)], NOW, 0).firing).toBe(false);
  });

  it("is healthy on a conclusive reachable check only", () => {
    expect(probeFamily([check("REACHABLE", 5)], NOW, 0).healthy).toBe(true);
    expect(probeFamily([check("DEGRADED", 5)], NOW, 0).healthy).toBe(false);
    expect(probeFamily([check("INCONCLUSIVE", 5)], NOW, 0).healthy).toBe(false);
  });

  it("skips checks the probe service could not answer, neither counting nor resetting them", () => {
    const result = probeFamily([check("UNREACHABLE", 5), check("INCONCLUSIVE", 35), check("UNREACHABLE", 65)], NOW, 0);
    expect(result.firing).toBe(true);
    const onlyNoise = probeFamily([check("INCONCLUSIVE", 5), check("INCONCLUSIVE", 35)], NOW, 0);
    expect(onlyNoise).toMatchObject({ firing: false, thin: true });
  });

  it("is thin when its data is old", () => {
    expect(probeFamily([check("UNREACHABLE", 200), check("UNREACHABLE", 230)], NOW, 0)).toMatchObject({
      firing: false,
      thin: true,
    });
  });

  it("does not count a partly reachable check toward a block", () => {
    expect(probeFamily([check("UNREACHABLE", 5), check("DEGRADED", 35), check("UNREACHABLE", 65)], NOW, 0).firing).toBe(
      false,
    );
  });

  it("reads vantage networks from the stored detail", () => {
    expect(vantageNetworks([{ asn: "AS1", ok: false }, { asn: "AS1", ok: true }, { asn: null, ok: false }])).toEqual([
      { asn: 0, org: null, tried: 1, failed: 1, baseline: null, failing: true },
      { asn: 1, org: null, tried: 2, failed: 1, baseline: null, failing: false },
    ]);
    expect(vantageNetworks("garbage")).toEqual([]);
  });
});

describe("assess", () => {
  const family = (f: FamilyResult["family"], over: Partial<FamilyResult> = {}): FamilyResult => ({
    family: f,
    firing: false,
    thin: false,
    healthy: false,
    onset: null,
    summary: "",
    networks: [],
    ...over,
  });
  const failingNets = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ asn: 64500 + i, org: null, tried: 4, failed: 4, baseline: 3, failing: true }));
  const base = { outage: null, previousSince: {}, now: NOW };

  it("one signal is a suspicion", () => {
    const a = assess({ ...base, client: family("client"), traffic: family("traffic", { firing: true }), probe: family("probe") });
    expect(a.verdict).toBe("SUSPECT");
    expect(a.since.traffic).toBe(NOW);
  });

  it("two signals at once are a likely block", () => {
    const a = assess({
      ...base,
      client: family("client"),
      traffic: family("traffic", { firing: true }),
      probe: family("probe", { firing: true, onset: NOW - HOUR, tcpOpen: false }),
    });
    expect(a.verdict).toBe("LIKELY_BLOCKED");
    expect(a.reason).toContain("traffic, probe");
    expect(a.blockType).toBe("address");
  });

  it("app reports on several networks become likely only once they have lasted", () => {
    const client = family("client", { firing: true, networks: failingNets(2), onset: NOW - 20 * MIN });
    const fresh = assess({ ...base, client, traffic: family("traffic", { thin: true }), probe: family("probe", { tcpOpen: true }) });
    expect(fresh.verdict).toBe("SUSPECT");
    const lasted = assess({
      ...base,
      previousSince: { client: NOW - 70 * MIN },
      client,
      traffic: family("traffic", { thin: true }),
      probe: family("probe", { tcpOpen: true }),
    });
    expect(lasted.verdict).toBe("LIKELY_BLOCKED");
    expect(lasted.since.client).toBe(NOW - 70 * MIN);
    expect(lasted.blockType).toBe("tunnel");
  });

  it("app reports alone are not enough while the server's traffic is as usual", () => {
    const a = assess({
      ...base,
      previousSince: { client: NOW - 10 * HOUR },
      client: family("client", { firing: true, networks: failingNets(3) }),
      traffic: family("traffic", { healthy: true }),
      probe: family("probe", { tcpOpen: true }),
    });
    expect(a.verdict).toBe("SUSPECT");
  });

  it("app reports on one network stay a suspicion however long", () => {
    const a = assess({
      ...base,
      previousSince: { client: NOW - 10 * HOUR },
      client: family("client", { firing: true, networks: failingNets(1) }),
      traffic: family("traffic"),
      probe: family("probe"),
    });
    expect(a.verdict).toBe("SUSPECT");
  });

  it("the probe alone pages after hours only when residential data is too thin to contradict it", () => {
    const probe = family("probe", { firing: true, onset: NOW - 7 * HOUR });
    const thin = assess({
      ...base,
      client: family("client", { thin: true }),
      traffic: family("traffic", { thin: true }),
      probe,
    });
    expect(thin.verdict).toBe("LIKELY_BLOCKED");
    expect(thin.reason).toContain("too thin");
    const contradicted = assess({ ...base, client: family("client", { thin: true }), traffic: family("traffic"), probe });
    expect(contradicted.verdict).toBe("SUSPECT");
  });

  it("an outage is never a block", () => {
    const a = assess({
      ...base,
      outage: "down everywhere",
      client: family("client", { firing: true, networks: failingNets(3) }),
      traffic: family("traffic", { firing: true }),
      probe: family("probe", { firing: true }),
    });
    expect(a).toMatchObject({ verdict: null, outage: "down everywhere" });
  });

  it("nothing firing is nothing", () => {
    expect(assess({ ...base, client: family("client"), traffic: family("traffic"), probe: family("probe") }).verdict).toBeNull();
  });

  it("guesses a protocol block when other protocols still carry", () => {
    const a = assess({
      ...base,
      client: family("client", { firing: true, networks: failingNets(1), carriedProtocols: ["A"], failedProtocols: ["B"] }),
      traffic: family("traffic"),
      probe: family("probe", { tcpOpen: true }),
    });
    expect(a.blockType).toBe("protocol");
  });
});

describe("recoveredFamilies", () => {
  const result = (family: FamilyResult["family"], healthy: boolean, thin = false): FamilyResult => ({
    family,
    firing: false,
    thin,
    healthy,
    onset: null,
    summary: "",
    networks: [],
  });

  it("counts only signals that fired and now show the server working", () => {
    const results = [result("client", false, true), result("traffic", true), result("probe", true)];
    expect(recoveredFamilies(["client", "traffic"], results)).toEqual(["traffic"]);
    // A tunnel block never stopped the probes connecting: that is no news.
    expect(recoveredFamilies(["client"], results)).toEqual([]);
  });
});
