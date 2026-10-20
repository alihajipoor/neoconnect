import {
  assess,
  clientFamily,
  probeFamily,
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

/** Customers who got through on `asn` during the past week. */
function baseline(asn: number, customers: number, prefix = "b"): NodeDial[] {
  return Array.from({ length: customers }, (_, i) => ({
    customerId: `${prefix}${asn}-${i}`,
    asn,
    carried: true,
    at: NOW - 2 * DAY,
    protocol: "VLESS",
  }));
}

/** Customers dialling `asn` in the last hour; `carried` of them got through. */
function recent(asn: number, total: number, carried: number, prefix = "r", protocol = "VLESS"): NodeDial[] {
  return Array.from({ length: total }, (_, i) => ({
    customerId: `${prefix}${asn}-${i}`,
    asn,
    carried: i < carried,
    at: NOW - 30 * MIN - i * MIN,
    protocol,
  }));
}

describe("clientFamily", () => {
  it("never fires from one report, however many rungs failed in it", () => {
    const one: NodeDial[] = Array.from({ length: 12 }, (_, i) => ({
      customerId: "c1",
      asn: 64500,
      carried: false,
      at: NOW - i * MIN,
      protocol: "VLESS",
    }));
    const result = clientFamily([...baseline(64500, 5), ...one], NOW, 0);
    expect(result.firing).toBe(false);
    expect(result.networks[0]).toMatchObject({ asn: 64500, tried: 1, failed: 1 });
  });

  it("fires when several customers on a network get nothing through where it used to work", () => {
    const result = clientFamily([...baseline(64500, 4), ...recent(64500, 4, 0)], NOW, 0, () => "Example Carrier");
    expect(result.firing).toBe(true);
    expect(result.networks[0]).toMatchObject({ asn: 64500, org: "Example Carrier", tried: 4, failed: 4, baseline: 4, failing: true });
    expect(result.summary).toContain("AS64500 (Example Carrier)");
    expect(result.onset).toBe(NOW - 33 * MIN);
  });

  it("does not call a network it never worked on a new block", () => {
    const result = clientFamily([...baseline(64500, 1), ...recent(64500, 6, 0)], NOW, 0);
    expect(result.firing).toBe(false);
    expect(result.networks[0].failing).toBe(false);
  });

  it("does not fire while a fair share still gets through", () => {
    // 2 of 6 carried is a third: a partial problem, not a block.
    const result = clientFamily([...baseline(64500, 4), ...recent(64500, 6, 2)], NOW, 0);
    expect(result.firing).toBe(false);
  });

  it("counts each customer by their latest dial: a retry that worked is a success", () => {
    const failedThenWorked: NodeDial[] = recent(64500, 4, 0).flatMap((d) => [
      d,
      { ...d, carried: true, at: d.at + MIN },
    ]);
    const result = clientFamily([...baseline(64500, 4), ...failedThenWorked], NOW, 0);
    expect(result.firing).toBe(false);
    expect(result.networks[0]).toMatchObject({ tried: 4, failed: 0 });
  });

  it("ignores everything before the owner's last answer", () => {
    const result = clientFamily([...baseline(64500, 4), ...recent(64500, 4, 0)], NOW, NOW - DAY);
    // The baseline was two days ago, before the floor: nothing to compare.
    expect(result.firing).toBe(false);
  });

  it("is thin with too few customers to judge", () => {
    expect(clientFamily(recent(64500, 2, 0), NOW, 0).thin).toBe(true);
    expect(clientFamily(recent(64500, 3, 3), NOW, 0).thin).toBe(false);
  });

  it("names protocols that still carry for the failing networks", () => {
    const dials = [...baseline(64500, 4), ...recent(64500, 4, 0, "r", "VLESS"), ...recent(64500, 1, 1, "s", "TROJAN")];
    const result = clientFamily(dials, NOW, 0);
    expect(result.firing).toBe(true);
    expect(result.carriedProtocols).toEqual(["TROJAN"]);
    expect(result.failedProtocols).toEqual(["VLESS"]);
  });
});

describe("trafficFamily", () => {
  const week = (n: number) => Array.from({ length: 7 }, () => n);

  it("fires on a cliff against the same hours on the days before", () => {
    const result = trafficFamily({ current: 2, baseline: week(14) });
    expect(result).toMatchObject({ firing: true, thin: false });
    expect(result.summary).toContain("usually 14");
  });

  it("does not fire on an ordinary dip", () => {
    expect(trafficFamily({ current: 8, baseline: week(14) }).firing).toBe(false);
  });

  it("is thin with too little history or too few users", () => {
    expect(trafficFamily({ current: 0, baseline: [14, 14, null, null, null, null, null] })).toMatchObject({
      firing: false,
      thin: true,
    });
    expect(trafficFamily({ current: 0, baseline: week(3) })).toMatchObject({ firing: false, thin: true });
    expect(trafficFamily(undefined)).toMatchObject({ firing: false, thin: true });
  });

  it("uses the median, so one busy day does not make an ordinary one a cliff", () => {
    expect(trafficFamily({ current: 5, baseline: [100, 8, 8, 9, 8, 7, 8] }).firing).toBe(false);
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
    expect(result).toMatchObject({ firing: true, onset: NOW - 35 * MIN, tcpOpen: false });
    expect(result.networks.map((n) => n.asn)).toEqual([64500, 64501]);
  });

  it("does not fire on a single unreachable check", () => {
    expect(probeFamily([check("UNREACHABLE", 5), check("REACHABLE", 35)], NOW, 0).firing).toBe(false);
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
    const fresh = assess({ ...base, client, traffic: family("traffic"), probe: family("probe", { tcpOpen: true }) });
    expect(fresh.verdict).toBe("SUSPECT");
    const lasted = assess({
      ...base,
      previousSince: { client: NOW - 70 * MIN },
      client,
      traffic: family("traffic"),
      probe: family("probe", { tcpOpen: true }),
    });
    expect(lasted.verdict).toBe("LIKELY_BLOCKED");
    expect(lasted.since.client).toBe(NOW - 70 * MIN);
    expect(lasted.blockType).toBe("tunnel");
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
