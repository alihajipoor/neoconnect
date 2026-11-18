import { deviceFactsFrom, fleetSummary, serviceChecksFrom, SUMMARY_NETWORKS, type DetailRow, type FleetRow } from "./service-checks";

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const MIN = 60_000;
const ROUTE_A = "route-a";
const ROUTE_B = "route-b";
const serverOf = new Map([
  [ROUTE_A, "alpha"],
  [ROUTE_B, "beta"],
]);

const svc = (key: string, host: string, ok: boolean, extra: Record<string, unknown> = {}) => ({
  key,
  host,
  ok,
  stage: ok ? "ok" : "tls",
  ...extra,
});

const row = (over: Partial<DetailRow>): DetailRow => ({
  kind: "CONNECT",
  platform: "android",
  sessionId: null,
  routeId: null,
  protocol: null,
  at: T0,
  details: null,
  ...over,
});

describe("deviceFactsFrom", () => {
  it("groups by session where named, else by platform, newest part of each", () => {
    // Newest first, as the insight hands them over.
    const rows = [
      row({ sessionId: "s1", at: T0, details: { net: { type: "wifi" } } }),
      row({ sessionId: "s1", at: T0 - MIN, details: { device: { model: "Pixel 7" }, net: { type: "cellular" } } }),
      row({ platform: "windows", at: T0 - 2 * MIN, details: { tunnel: { mode: "full" } } }),
      row({ platform: "windows", at: T0 - 3 * MIN, details: null }),
      row({ platform: "ios", at: T0 - 4 * MIN, details: null }),
    ];
    const facts = deviceFactsFrom(rows, new Map([["s1", "Android phone (Pixel 7)"]]));
    expect(facts).toEqual([
      {
        sessionId: "s1",
        platform: "android",
        label: "Android phone (Pixel 7)",
        lastSeenAt: new Date(T0).toISOString(),
        device: { model: "Pixel 7" },
        net: { type: "wifi" },
        tunnel: null,
      },
      {
        sessionId: null,
        platform: "windows",
        label: null,
        lastSeenAt: new Date(T0 - 2 * MIN).toISOString(),
        device: null,
        net: null,
        tunnel: { mode: "full" },
      },
    ]);
  });
});

describe("serviceChecksFrom", () => {
  it("counts runs, keeps the newest result per key, and groups by server", () => {
    const rows = [
      row({ kind: "CONNECT", details: { device: { os: "android" } } }),
      row({
        kind: "SERVICE_CHECK",
        at: T0 - MIN,
        routeId: ROUTE_A,
        protocol: "Stealth",
        details: { via: "tunnel", services: [svc("google", "www.google.com", true, { tlsMs: 90 }), svc("x", "x.com", false)] },
      }),
      row({
        kind: "SERVICE_CHECK",
        at: T0 - 2 * MIN,
        routeId: ROUTE_A,
        protocol: "Stealth",
        details: { via: "tunnel", services: [svc("google", "www.google.com", false), svc("x", "x.com", false)] },
      }),
      row({
        kind: "SERVICE_CHECK",
        at: T0 - 3 * MIN,
        routeId: ROUTE_B,
        details: { via: "direct", services: [svc("google", "www.google.com", true)] },
      }),
    ];
    const checks = serviceChecksFrom(rows, serverOf);
    expect(checks.runs).toBe(3);
    expect(checks.lastRunAt).toBe(new Date(T0 - MIN).toISOString());
    expect(checks.latest).toEqual([
      expect.objectContaining({ key: "google", label: "Google", ok: true, tlsMs: 90, server: "alpha", protocol: "Stealth", via: "tunnel" }),
      expect.objectContaining({ key: "x", label: "X", ok: false, stage: "tls", dnsMs: null, server: "alpha" }),
    ]);
    expect(checks.byServer).toEqual([
      {
        server: "alpha",
        protocol: "Stealth",
        runs: 2,
        perService: [
          { key: "google", ok: 1, failed: 1 },
          { key: "x", ok: 0, failed: 2 },
        ],
      },
      // A direct run went through no server, whatever route it named.
      { server: null, protocol: null, runs: 1, perService: [{ key: "google", ok: 1, failed: 0 }] },
    ]);
  });

  it("says there were none rather than inventing a run", () => {
    expect(serviceChecksFrom([row({ kind: "CONNECT" })], serverOf)).toEqual({ lastRunAt: null, runs: 0, latest: [], byServer: [] });
  });
});

describe("fleetSummary", () => {
  const network = (asn: number) => ({ name: `AS${asn} Example`, country: "ZZ" });
  const fleet = (over: Partial<FleetRow>): FleetRow => ({ customerId: "c1", routeId: ROUTE_A, protocol: "Stealth", asn: 64500, details: null, ...over });

  it("counts per server through the tunnel only, with medians and the commonest failing stage", () => {
    const rows = [
      fleet({ customerId: "c1", details: { via: "tunnel", services: [svc("google", "www.google.com", true, { tlsMs: 100, firstByteMs: 200 })] } }),
      fleet({ customerId: "c2", details: { via: "tunnel", services: [svc("google", "www.google.com", true, { tlsMs: 300, firstByteMs: 500 })] } }),
      fleet({ customerId: "c2", details: { via: "tunnel", services: [svc("google", "www.google.com", false, { stage: "http", tlsMs: 250 })] } }),
      fleet({ customerId: "c3", details: { via: "tunnel", services: [svc("google", "www.google.com", false, { stage: "tls" })] } }),
      fleet({ customerId: "c3", details: { via: "tunnel", services: [svc("google", "www.google.com", false, { stage: "tls" })] } }),
      // Direct, and one that says nothing of how it went: not a server's.
      fleet({ customerId: "c4", details: { via: "direct", services: [svc("google", "www.google.com", false, { tlsMs: 9000 })] } }),
      fleet({ customerId: null, details: { services: [svc("google", "www.google.com", false)] } }),
    ];
    const summary = fleetSummary(24, rows, serverOf, network);
    expect(summary).toMatchObject({ hours: 24, runs: 7, customers: 4 });
    expect(summary.targets).toHaveLength(9);
    expect(summary.byServer).toEqual([
      {
        server: "alpha",
        protocol: "Stealth",
        runs: 5,
        customers: 3,
        perService: [
          { key: "google", ok: 2, failed: 3, medianTlsMs: 250, medianFirstByteMs: 350, topFailStage: "tls" },
        ],
      },
    ]);
    expect(summary.byNetwork).toEqual([
      { asn: 64500, name: "AS64500 Example", country: "ZZ", runs: 7, customers: 4, perService: [{ key: "google", ok: 2, failed: 5 }] },
    ]);
  });

  it("lists the fifteen networks with the most runs", () => {
    const rows: FleetRow[] = [];
    for (let i = 0; i < 20; i++) for (let n = 0; n <= i; n++) rows.push(fleet({ asn: 64500 + i, details: { via: "direct" } }));
    const summary = fleetSummary(24, rows, serverOf, network);
    expect(summary.byNetwork).toHaveLength(SUMMARY_NETWORKS);
    expect(summary.byNetwork[0]).toMatchObject({ asn: 64519, runs: 20 });
    expect(summary.byNetwork.at(-1)).toMatchObject({ asn: 64505, runs: 6 });
    expect(summary.byServer).toEqual([]);
  });

  it("gives null medians where no run carried the figure", () => {
    const summary = fleetSummary(
      1,
      [fleet({ details: { via: "tunnel", services: [svc("x", "x.com", false, { stage: "dns" })] } })],
      serverOf,
      network,
    );
    expect(summary.byServer[0].perService[0]).toEqual({ key: "x", ok: 0, failed: 1, medianTlsMs: null, medianFirstByteMs: null, topFailStage: "dns" });
  });
});
