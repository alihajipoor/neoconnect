/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-call -- the in-memory
 * Prisma stand-in below reads untyped rows and answers like the real
 * client, asynchronously. */
import { createServer, type Server } from "node:net";
import { HELD_FOR_BLOCK_WATCH } from "./block-watch.mode";
import {
  BlockWatchService,
  firstDayOf,
  MAX_PAGE_ATTEMPTS,
  PAGES_PER_HOUR,
  parseBlockWatchMode,
  RESERVED_FOR_NEW,
  tcpReachable,
  trafficSince,
} from "./block-watch.service";
import { DEFAULT_TUNING } from "./block-signals";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-19T12:00:00Z");
const ASN_A = 64500;
const ASN_B = 64501;
const FOREIGN_ASN = 64999;

type Row = Record<string, any>;

/** Just enough of a where clause for the queries the service makes. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === "object" && !Array.isArray(cond)) {
      if ("in" in cond && !cond.in.includes(value)) return false;
      if ("not" in cond) {
        if (cond.not === null ? value === null || value === undefined : value === cond.not) return false;
      }
      const t = value instanceof Date ? value.getTime() : value;
      const v = (x: unknown) => (x instanceof Date ? x.getTime() : x);
      if ("gte" in cond && !(t !== null && t !== undefined && t >= v(cond.gte)!)) return false;
      if ("gt" in cond && !(t !== null && t !== undefined && t > v(cond.gt)!)) return false;
      if ("lte" in cond && !(t !== null && t !== undefined && t <= v(cond.lte)!)) return false;
      if ("lt" in cond && !(t !== null && t !== undefined && t < v(cond.lt)!)) return false;
      return true;
    }
    return value === cond;
  });
}

interface World {
  nodes: Row[];
  attempts: Row[];
  routes: Row[];
  checks: Row[];
  subscriptions: Row[];
  /** usage: [nodeId, subscriptionId, reportedAt ms, bytesUp] */
  usage: [string, string, number, number][];
  incidents: Row[];
  alerts: Row[];
}

/** latestDialsSql, as Postgres answers it: per customer, network and
 * route, the latest rung -- by the time the client gives (never after
 * arrival), then arrival, then place in the ladder. */
function latestDials(world: World, sql: { values: unknown[] }): Row[] {
  const [sinceMs, ...asns] = sql.values as number[];
  const best = new Map<string, Row>();
  for (const a of world.attempts) {
    if (!a.customerId || !asns.includes(a.asn) || a.createdAt.getTime() < sinceMs) continue;
    const arrived = a.createdAt.getTime();
    const said = a.occurredAt?.getTime();
    const happened = said !== undefined && said <= arrived ? said : arrived;
    (Array.isArray(a.attemptsJson) ? a.attemptsJson : []).forEach((rung: Row, i: number) => {
      if (typeof rung?.routeId !== "string" || typeof rung?.carried !== "boolean") return;
      const row = {
        customerId: a.customerId,
        asn: a.asn,
        routeId: rung.routeId,
        carried: rung.carried,
        happenedAt: new Date(happened),
        createdAt: a.createdAt,
        rung: i + 1,
      };
      const key = `${a.customerId}|${a.asn}|${rung.routeId}`;
      const held = best.get(key);
      const later = held
        ? happened - held.happenedAt.getTime() || arrived - held.createdAt.getTime() || row.rung - held.rung
        : 1;
      if (later > 0) best.set(key, row);
    });
  }
  return [...best.values()];
}

function fakePrisma(world: World) {
  let seq = 0;
  const withNode = (i: Row) => ({ ...i, node: { ...world.nodes.find((n) => n.id === i.nodeId) } });
  const usageGroups = ({ where, having }: Row) => {
    const sums = new Map<string, number>();
    for (const [nodeId, subscriptionId, at, up] of world.usage) {
      if (!matches({ nodeId, subscriptionId, reportedAt: new Date(at) }, where)) continue;
      const key = `${nodeId}|${subscriptionId}`;
      sums.set(key, (sums.get(key) ?? 0) + up);
    }
    return [...sums]
      .filter(([, up]) => up >= having.bytesUp._sum.gte)
      .map(([key]) => ({ nodeId: key.split("|")[0], subscriptionId: key.split("|")[1] }));
  };
  return {
    node: {
      findMany: jest.fn(async ({ where }: Row) => world.nodes.filter((n) => matches(n, where))),
    },
    blockIncident: {
      findMany: jest.fn(async ({ where, include, select, distinct, orderBy }: Row) => {
        let rows = world.incidents.filter((i) => matches(i, where));
        if (orderBy?.closedAt === "desc") {
          rows = [...rows].sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
        }
        if (distinct) {
          const seen = new Set<string>();
          rows = rows.filter((r) => (seen.has(r.nodeId) ? false : (seen.add(r.nodeId), true)));
        }
        return include || select?.node ? rows.map(withNode) : rows.map((r) => ({ ...r }));
      }),
      findUnique: jest.fn(async ({ where }: Row) => {
        const row = world.incidents.find((i) => i.id === where.id);
        return row ? withNode(row) : null;
      }),
      create: jest.fn(async ({ data }: Row) => {
        const row = {
          id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
          status: "OPEN",
          quietCycles: 0,
          pagedAt: null,
          pageError: null,
          pageAttempts: 0,
          remindedAt: null,
          recoveryNotifiedAt: null,
          digestedAt: null,
          reopenedAt: null,
          keptAt: null,
          snoozedUntil: null,
          closedAt: null,
          likelyAt: null,
          actedBy: null,
          actionNote: null,
          firedFamilies: [],
          failedAsns: [],
          ...data,
        };
        world.incidents.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: Row) => {
        const row = world.incidents.find((i) => i.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: Row) => {
        const rows = world.incidents.filter((i) => matches(i, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
      count: jest.fn(async ({ where }: Row) => world.incidents.filter((i) => matches(i, where)).length),
      aggregate: jest.fn(async ({ where }: Row) => {
        const times = world.incidents
          .filter((i) => matches(i, where) && i.digestedAt)
          .map((i) => i.digestedAt.getTime());
        return { _max: { digestedAt: times.length ? new Date(Math.max(...times)) : null } };
      }),
    },
    clientAttempt: {
      groupBy: jest.fn(async ({ where }: Row) => [
        ...new Set(
          world.attempts
            .filter((a) => a.customerId && a.createdAt.getTime() >= where.createdAt.gte.getTime())
            .map((a) => a.asn),
        ),
      ].map((asn) => ({ asn }))),
    },
    $queryRaw: jest.fn(async (sql: { values: unknown[] }) => latestDials(world, sql)),
    route: { findMany: jest.fn(async () => world.routes) },
    subscription: {
      findMany: jest.fn(async ({ where }: Row) => world.subscriptions.filter((s) => matches(s, where))),
    },
    nodeReachabilityCheck: {
      findMany: jest.fn(async ({ where }: Row) =>
        world.checks
          .filter((c) => c.checkedAt.getTime() >= where.checkedAt.gte.getTime())
          .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime()),
      ),
    },
    insideProbeCheck: { findMany: jest.fn(async () => []) },
    nodeReachabilityAlert: {
      findMany: jest.fn(async ({ where }: Row) => world.alerts.filter((a) => matches(a, where)).map(withNode)),
    },
    usageRecord: { groupBy: jest.fn(async (args: Row) => usageGroups(args)) },
  };
}

function build(mode: string, world: Partial<World> = {}, opts: { tuning?: string } = {}) {
  const w: World = {
    nodes: [{ id: "n1", name: "germany-1", status: "ONLINE", publicIp: "192.0.2.10", realityDestReachable: true }],
    attempts: [],
    routes: [{ id: "r1", entryProtocolConfig: { nodeId: "n1", protocol: "XRAY_VLESS_REALITY" } }],
    checks: [],
    subscriptions: [],
    usage: [],
    incidents: [],
    alerts: [],
    ...world,
  };
  const prisma = fakePrisma(w);
  const settings: Record<string, unknown> = {
    "blockWatch.mode": mode,
    "blockWatch.tuning": opts.tuning ?? "",
    "reachability.country": "ir",
    "reachability.port": 443,
  };
  const config = { get: jest.fn((key: string) => settings[key]) };
  const identity = {
    countryOfAsn: jest.fn((asn: number) => (asn === FOREIGN_ASN ? "DE" : "IR")),
    orgOf: jest.fn(() => "Example Carrier"),
  };
  const pages: { subject: string; text: string }[] = [];
  let delivered = true;
  const pager = {
    page: jest.fn(async (p: { subject: string; text: string }) => {
      pages.push(p);
      return delivered
        ? { webhook: true, mailed: ["o@x.test"], failed: [], delivered: true, error: null }
        : { webhook: false, mailed: [], failed: ["o@x.test"], delivered: false, error: "could not mail o@x.test" };
    }),
  };
  const service = new BlockWatchService(prisma as never, config as never, identity as never, pager as never);
  service.tcpReachable = jest.fn(async () => true);
  /** Pages other than the daily digest. */
  const alerts = () => pages.filter((p) => !p.subject.startsWith("[Neoxify] Block watch:"));
  const digests = () => pages.filter((p) => p.subject.startsWith("[Neoxify] Block watch:"));
  const setDelivered = (value: boolean) => {
    delivered = value;
  };
  return { service, world: w, prisma, pages, alerts, digests, pager, config, setDelivered };
}

/** `n` signed-in customers on `asn` who dialled `routeId` at `at`. */
function reports(asn: number, n: number, carried: boolean, at: number, prefix: string, routeId = "r1"): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    customerId: `${prefix}-${asn}-${i}`,
    asn,
    attemptsJson: [{ protocol: "Fast", result: carried ? "connected" : "up but unreachable", routeId, carried }],
    createdAt: new Date(at),
    occurredAt: null,
  }));
}

/** What the server measured for those customers two days before T0: real
 * upstream, so it had carried traffic for them. */
function usedBefore(customers: string[], nodeId = "n1"): Pick<World, "subscriptions" | "usage"> {
  return {
    subscriptions: customers.map((c) => ({ id: `sub-${c}`, customerId: c })),
    usage: customers.map((c) => [nodeId, `sub-${c}`, T0 - 2 * DAY - 6 * HOUR, 50_000] as [string, string, number, number]),
  };
}

/** Four customers on each of two networks, whom the server carried for
 * before, getting nothing through at `now`. */
function blockedReports(now: number, routeId = "r1", prefix = "now"): Row[] {
  return [...reports(ASN_A, 4, false, now - 20 * MIN, prefix, routeId), ...reports(ASN_B, 4, false, now - 20 * MIN, prefix, routeId)];
}
function blocked(now: number, nodeId = "n1", routeId = "r1", prefix = "now"): Pick<World, "attempts" | "subscriptions" | "usage"> {
  const attempts = blockedReports(now, routeId, prefix);
  return { attempts, ...usedBefore([...new Set(attempts.map((a) => a.customerId as string))], nodeId) };
}

function unreachableChecks(nodeId: string, now: number, count = 3): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    nodeId,
    verdict: "UNREACHABLE",
    checkedAt: new Date(now - i * 30 * MIN - MIN),
    detailJson: [
      { vantage: "v1", asn: "AS64500", ok: false },
      { vantage: "v2", asn: "AS64501", ok: false },
    ],
  }));
}

function reachableChecks(nodeId: string, now: number): Row[] {
  return [
    {
      nodeId,
      verdict: "REACHABLE",
      checkedAt: new Date(now - MIN),
      detailJson: [
        { vantage: "v1", asn: "AS64500", ok: true },
        { vantage: "v2", asn: "AS64501", ok: true },
      ],
    },
  ];
}

describe("parseBlockWatchMode", () => {
  it.each([
    [undefined, "off"],
    ["", "off"],
    ["notfy", "off"],
    [" Record ", "record"],
    ["digest", "digest"],
    ["NOTIFY", "notify"],
  ])("%j is %s", (raw, mode) => {
    expect(parseBlockWatchMode(raw)).toBe(mode);
  });
});

describe("BlockWatchService", () => {
  it("does nothing at all when off", async () => {
    const { service, prisma } = build("off", blocked(T0));
    expect(await service.runCycle(new Date(T0))).toEqual([]);
    expect(prisma.node.findMany).not.toHaveBeenCalled();
  });

  it("records without sending anything in record mode", async () => {
    const { service, world, pages } = build("record", blocked(T0));
    await service.runCycle(new Date(T0));
    expect(world.incidents).toHaveLength(1);
    expect(world.incidents[0]).toMatchObject({ nodeId: "n1", status: "OPEN", verdict: "SUSPECT" });
    expect(world.incidents[0].firedFamilies).toEqual(["client"]);
    expect(world.incidents[0].failedAsns.sort()).toEqual([ASN_A, ASN_B]);
    expect(pages).toHaveLength(0);
  });

  it("opens nothing from a single customer's reports, however many", async () => {
    const one = reports(ASN_A, 1, false, T0 - 10 * MIN, "now");
    const again = Array.from({ length: 10 }, (_, i) => ({ ...one[0], createdAt: new Date(T0 - i * MIN) }));
    const { service, world, pages } = build("notify", { attempts: again, ...usedBefore(["now-64500-0"]) });
    await service.runCycle(new Date(T0));
    expect(world.incidents).toHaveLength(0);
    expect(pages).toHaveLength(0);
  });

  it("opens nothing for accounts the server never carried traffic for", async () => {
    const { service, world } = build("notify", { attempts: blockedReports(T0) });
    await service.runCycle(new Date(T0));
    expect(world.incidents).toHaveLength(0);
  });

  it("reads only the watched country's networks, and no relayed routes", async () => {
    const attempts = [
      ...reports(FOREIGN_ASN, 5, false, T0 - 10 * MIN, "now"),
      ...reports(ASN_A, 5, false, T0 - 10 * MIN, "rnow", "relay-route"),
    ];
    const { service, world, prisma } = build("notify", {
      attempts,
      ...usedBefore([...new Set(attempts.map((a) => a.customerId as string))]),
    });
    await service.runCycle(new Date(T0));
    expect(world.incidents).toHaveLength(0);
    // The foreign network never reaches the query.
    expect(prisma.$queryRaw.mock.calls[0][0].values.slice(1)).toEqual([ASN_A]);
  });

  it("follows BLOCK_WATCH_TUNING", async () => {
    const { service, world } = build("record", blocked(T0), { tuning: "minFailedPerNetwork=5" });
    await service.runCycle(new Date(T0));
    expect(world.incidents).toHaveLength(0);
  });

  it("pages once when reports on two networks have lasted, never twice for one incident", async () => {
    const { service, world, alerts: pages, digests } = build("notify", blocked(T0));
    await service.runCycle(new Date(T0));
    expect(world.incidents[0].verdict).toBe("SUSPECT");
    expect(pages()).toHaveLength(0);
    // A suspicion goes to the digest, not the pager.
    expect(digests()).toHaveLength(1);
    expect(digests()[0].text).toContain("germany-1 -- suspect");

    // Later, same evidence, now over an hour old.
    world.attempts = blockedReports(T0 + 70 * MIN);
    await service.runCycle(new Date(T0 + 70 * MIN));
    expect(world.incidents[0].verdict).toBe("LIKELY_BLOCKED");
    expect(pages()).toHaveLength(1);
    expect(pages()[0].subject).toBe("[Neoxify] germany-1 is likely blocked from IR");
    expect(pages()[0].text).toContain("AS64500 (Example Carrier)");
    expect(pages()[0].text).not.toContain("192.0.2.10");
    expect(world.incidents[0].pagedAt).toEqual(new Date(T0 + 70 * MIN));

    world.attempts = blockedReports(T0 + 100 * MIN);
    await service.runCycle(new Date(T0 + 100 * MIN));
    expect(pages()).toHaveLength(1);
    expect(digests()).toHaveLength(1);
    expect(world.incidents).toHaveLength(1);
  });

  it("does not page app reports alone while the server's traffic is as usual", async () => {
    const world = blocked(T0);
    // Ten others keep sending as on every other day.
    for (let day = 0; day <= 7; day += 1) {
      for (let s = 0; s < 10; s += 1) world.usage.push(["n1", `busy-${s}`, T0 + 70 * MIN - day * DAY - 30 * MIN, 50_000]);
    }
    const { service, world: w, alerts } = build("notify", world);
    await service.runCycle(new Date(T0));
    w.attempts = blockedReports(T0 + 70 * MIN);
    await service.runCycle(new Date(T0 + 70 * MIN));
    expect(w.incidents[0].evidenceJson.current).toBe("SUSPECT");
    expect(alerts()).toHaveLength(0);
  });

  it("pages at once when two signals agree", async () => {
    const { service, world, pages } = build("notify", { ...blocked(T0), checks: unreachableChecks("n1", T0) });
    await service.runCycle(new Date(T0));
    expect(world.incidents[0].verdict).toBe("LIKELY_BLOCKED");
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toContain("independent signals agree");
    expect(pages[0].text).toContain("address or its port");
  });

  it("calls it an outage, not a block, when the port is dead from abroad too", async () => {
    const { service, world, pages } = build("notify", { ...blocked(T0), checks: unreachableChecks("n1", T0) });
    service.tcpReachable = jest.fn(async () => false);
    const [summary] = await service.runCycle(new Date(T0));
    expect(summary.outage).toContain("not blocked");
    expect(world.incidents).toHaveLength(0);
    expect(pages).toHaveLength(0);
  });

  it("checks the port whatever fired: a dead engine fails app reports as a block does", async () => {
    const { service, world } = build("notify", blocked(T0));
    service.tcpReachable = jest.fn(async () => false);
    const [summary] = await service.runCycle(new Date(T0));
    expect(service.tcpReachable).toHaveBeenCalledWith("192.0.2.10", 443, expect.any(Number));
    expect(summary.outage).toContain("engine is down");
    expect(world.incidents).toHaveLength(0);
  });

  it("calls it an outage when the agent is offline, and holds an open incident rather than clearing it", async () => {
    const { service, world } = build("record", blocked(T0));
    await service.runCycle(new Date(T0));
    world.nodes[0].status = "OFFLINE";
    world.attempts = [];
    for (let i = 1; i <= 3; i += 1) await service.runCycle(new Date(T0 + i * 30 * MIN));
    expect(world.incidents[0]).toMatchObject({ status: "OPEN", quietCycles: 0 });
    expect(world.incidents[0].evidenceJson.outage).toContain("offline");
  });

  it("clears only when the server is shown working again, and then tells the owner", async () => {
    const { service, world, pages } = build("notify", { ...blocked(T0), checks: unreachableChecks("n1", T0) });
    await service.runCycle(new Date(T0));
    expect(pages).toHaveLength(1);
    world.attempts = [];
    world.checks = reachableChecks("n1", T0 + 30 * MIN);
    await service.runCycle(new Date(T0 + 30 * MIN));
    expect(world.incidents[0]).toMatchObject({ status: "OPEN", quietCycles: 1 });
    expect(world.incidents[0].evidenceJson.clearing).toContain("the probes connect again");
    world.checks = reachableChecks("n1", T0 + 60 * MIN);
    await service.runCycle(new Date(T0 + 60 * MIN));
    expect(world.incidents[0].status).toBe("CLEARED");
    expect(pages).toHaveLength(2);
    expect(pages[1].subject).toBe("[Neoxify] germany-1 works from IR again");
    expect(pages[1].text).toContain("the probes connect again");
    expect(world.incidents[0].recoveryNotifiedAt).toEqual(new Date(T0 + 60 * MIN));
  });

  it("holds an incident open when its evidence merely runs out", async () => {
    const { service, world, pages } = build("notify", { ...blocked(T0), checks: unreachableChecks("n1", T0) });
    await service.runCycle(new Date(T0));
    // The apps steer people elsewhere and the probe service goes quiet.
    world.attempts = [];
    world.checks = [];
    for (let i = 1; i <= 4; i += 1) await service.runCycle(new Date(T0 + i * 30 * MIN));
    expect(world.incidents[0]).toMatchObject({ status: "OPEN", quietCycles: 0 });
    expect(world.incidents[0].evidenceJson.clearing).toContain("too little data");
    expect(pages).toHaveLength(1);
  });

  it("does not take a probe that was never failing as a sign a tunnel block ended", async () => {
    const { service, world } = build("record", { ...blocked(T0), checks: reachableChecks("n1", T0) });
    await service.runCycle(new Date(T0));
    expect(world.incidents[0].firedFamilies).toEqual(["client"]);
    world.attempts = [];
    for (let i = 1; i <= 3; i += 1) {
      world.checks = reachableChecks("n1", T0 + i * 30 * MIN);
      await service.runCycle(new Date(T0 + i * 30 * MIN));
    }
    expect(world.incidents[0].status).toBe("OPEN");
  });

  it("clears a tunnel block when the networks that failed carry again", async () => {
    const { service, world } = build("record", blocked(T0));
    await service.runCycle(new Date(T0));
    for (let i = 1; i <= 2; i += 1) {
      const at = T0 + i * 30 * MIN;
      world.attempts = [...reports(ASN_A, 4, true, at - 5 * MIN, "now"), ...reports(ASN_B, 4, true, at - 5 * MIN, "now")];
      await service.runCycle(new Date(at));
    }
    expect(world.incidents[0].status).toBe("CLEARED");
    expect(world.incidents[0].evidenceJson.clearing).toContain("carry again");
  });

  it("re-opens an incident that comes back soon after it cleared, and does not page it again", async () => {
    const { service, world, alerts } = build("notify", { ...blocked(T0), checks: unreachableChecks("n1", T0) });
    await service.runCycle(new Date(T0));
    world.attempts = [];
    for (const at of [T0 + 30 * MIN, T0 + 60 * MIN]) {
      world.checks = reachableChecks("n1", at);
      await service.runCycle(new Date(at));
    }
    expect(world.incidents[0].status).toBe("CLEARED");
    expect(alerts()).toHaveLength(2);

    const back = T0 + 5 * HOUR;
    world.attempts = blockedReports(back);
    world.checks = unreachableChecks("n1", back);
    await service.runCycle(new Date(back));
    expect(world.incidents).toHaveLength(1);
    expect(world.incidents[0]).toMatchObject({ status: "OPEN", closedAt: null, reopenedAt: new Date(back) });
    expect(alerts()).toHaveLength(2);
  });

  it("sends one grouped message when several servers look blocked at once", async () => {
    const nodes = ["n1", "n2", "n3"].map((id, i) => ({
      id,
      name: `server-${i + 1}`,
      status: "ONLINE",
      publicIp: `192.0.2.${i + 1}`,
      realityDestReachable: true,
    }));
    const routes = nodes.map((n) => ({ id: `r-${n.id}`, entryProtocolConfig: { nodeId: n.id, protocol: "XRAY_VLESS_REALITY" } }));
    const parts = nodes.map((n) => blocked(T0, n.id, `r-${n.id}`, `now-${n.id}`));
    const checks = nodes.flatMap((n) => unreachableChecks(n.id, T0));
    const { service, world, pages } = build("notify", {
      nodes,
      routes,
      checks,
      attempts: parts.flatMap((p) => p.attempts),
      subscriptions: parts.flatMap((p) => p.subscriptions),
      usage: parts.flatMap((p) => p.usage),
    });
    await service.runCycle(new Date(T0));
    expect(world.incidents.filter((i) => i.verdict === "LIKELY_BLOCKED")).toHaveLength(3);
    expect(pages).toHaveLength(1);
    expect(pages[0].subject).toBe("[Neoxify] 3 servers look blocked from IR at once");
    expect(pages[0].text).toContain("international cut");
    expect(world.incidents.every((i) => i.pagedAt)).toBe(true);

    // A day on, one reminder for all three; then one notice when they work.
    const later = T0 + 25 * HOUR;
    world.attempts = nodes.flatMap((n) => blockedReports(later, `r-${n.id}`, `now-${n.id}`));
    world.checks = nodes.flatMap((n) => unreachableChecks(n.id, later));
    await service.runCycle(new Date(later));
    expect(pages.map((p) => p.subject)).toContain("[Neoxify] Reminder: 3 servers still look blocked from IR");
    world.attempts = [];
    for (const at of [later + 30 * MIN, later + 60 * MIN]) {
      world.checks = nodes.flatMap((n) => reachableChecks(n.id, at));
      await service.runCycle(new Date(at));
    }
    const notices = pages.filter((p) => p.subject.includes("work from IR again"));
    expect(notices.map((p) => p.subject)).toEqual(["[Neoxify] 3 servers work from IR again"]);
  });

  it("holds pages over the hourly budget for the next cycle instead of dropping them", async () => {
    const { service, world, pages } = build("notify", { ...blocked(T0), checks: unreachableChecks("n1", T0) });
    const budget = (service as unknown as { budget: { take(now: number): boolean } }).budget;
    for (let i = 0; i < PAGES_PER_HOUR; i += 1) budget.take(T0 - MIN);
    await service.runCycle(new Date(T0));
    expect(pages).toHaveLength(0);
    expect(world.incidents[0].pagedAt).toBeNull();

    world.attempts = blockedReports(T0 + HOUR);
    world.checks = unreachableChecks("n1", T0 + HOUR);
    await service.runCycle(new Date(T0 + HOUR));
    expect(pages).toHaveLength(1);
  });

  it("keeps budget for new pages: reminders wait while it runs low", async () => {
    const { service, world, alerts } = build("notify", { ...blocked(T0), checks: unreachableChecks("n1", T0) });
    await service.runCycle(new Date(T0));
    const later = T0 + 25 * HOUR;
    const budget = (service as unknown as { budget: { take(now: number): boolean } }).budget;
    for (let i = 0; i < PAGES_PER_HOUR - RESERVED_FOR_NEW; i += 1) budget.take(later - MIN);
    world.attempts = blockedReports(later);
    world.checks = unreachableChecks("n1", later);
    await service.runCycle(new Date(later));
    expect(alerts()).toHaveLength(1);
    expect(world.incidents[0].remindedAt).toBeNull();
  });

  it("does not record a page that reached nobody, tries again, then lists it in the digest", async () => {
    const { service, world, alerts, digests, setDelivered } = build("notify", {
      ...blocked(T0),
      checks: unreachableChecks("n1", T0),
    });
    setDelivered(false);
    for (let i = 0; i < MAX_PAGE_ATTEMPTS + 1; i += 1) {
      const at = T0 + i * 30 * MIN;
      world.attempts = blockedReports(at);
      world.checks = unreachableChecks("n1", at);
      await service.runCycle(new Date(at));
    }
    expect(alerts()).toHaveLength(MAX_PAGE_ATTEMPTS);
    expect(world.incidents[0]).toMatchObject({ pagedAt: null, pageAttempts: MAX_PAGE_ATTEMPTS });
    expect(world.incidents[0].pageError).toContain("could not mail");

    const nextDay = T0 + 25 * HOUR;
    world.attempts = blockedReports(nextDay);
    world.checks = unreachableChecks("n1", nextDay);
    await service.runCycle(new Date(nextDay));
    expect(digests().at(-1)!.text).toContain("Pages that reached nobody");
    expect(digests().at(-1)!.text).toContain("germany-1");
  });

  it("reminds once after a day, unless the owner said keep", async () => {
    const run = async (keep: boolean) => {
      const { service, world, pages } = build("notify", { ...blocked(T0), checks: unreachableChecks("n1", T0) });
      await service.runCycle(new Date(T0));
      if (keep) await service.act(world.incidents[0].id, "keep", "owner@x.test", {}, new Date(T0 + MIN));
      for (const at of [T0 + 25 * HOUR, T0 + 26 * HOUR]) {
        world.attempts = blockedReports(at);
        world.checks = unreachableChecks("n1", at);
        await service.runCycle(new Date(at));
      }
      return pages.filter((p) => !p.subject.startsWith("[Neoxify] Block watch:"));
    };
    const reminded = await run(false);
    expect(reminded.map((p) => p.subject)).toEqual([
      "[Neoxify] germany-1 is likely blocked from IR",
      "[Neoxify] Reminder: germany-1 still looks blocked from IR",
    ]);
    expect(await run(true)).toHaveLength(1);
  });

  it("holds the page while snoozed and sends it after", async () => {
    const { service, world, alerts } = build("notify", blocked(T0));
    await service.runCycle(new Date(T0));
    await service.act(world.incidents[0].id, "snooze", "owner@x.test", { hours: 2 }, new Date(T0 + MIN));
    world.attempts = blockedReports(T0 + 70 * MIN);
    await service.runCycle(new Date(T0 + 70 * MIN));
    expect(world.incidents[0].verdict).toBe("LIKELY_BLOCKED");
    expect(alerts()).toHaveLength(0);
    world.attempts = blockedReports(T0 + 130 * MIN);
    await service.runCycle(new Date(T0 + 130 * MIN));
    expect(alerts()).toHaveLength(1);
  });

  it("does not page an incident whose latest evaluation fell back to a suspicion", async () => {
    const { service, world, alerts } = build("notify", blocked(T0));
    await service.runCycle(new Date(T0));
    await service.act(world.incidents[0].id, "snooze", "owner@x.test", { hours: 2 }, new Date(T0 + MIN));
    world.attempts = blockedReports(T0 + 70 * MIN);
    await service.runCycle(new Date(T0 + 70 * MIN));
    expect(world.incidents[0].verdict).toBe("LIKELY_BLOCKED");
    // After the snooze only one network still fails.
    world.attempts = reports(ASN_A, 4, false, T0 + 110 * MIN, "now");
    await service.runCycle(new Date(T0 + 130 * MIN));
    expect(world.incidents[0].evidenceJson.current).toBe("SUSPECT");
    expect(alerts()).toHaveLength(0);
  });

  it("takes Replaced only once the server has a new address, and then starts over", async () => {
    const { service, world } = build("record", blocked(T0));
    await service.runCycle(new Date(T0));
    const id = world.incidents[0].id;
    await expect(service.act(id, "replaced", "owner@x.test", {}, new Date(T0 + MIN))).rejects.toThrow(
      "still has the address",
    );
    world.nodes[0].publicIp = "192.0.2.99";
    const replaced = await service.act(id, "replaced", "owner@x.test", { note: "new VPS" }, new Date(T0 + MIN));
    expect(replaced.status).toBe("REPLACED");
    expect(world.incidents[0]).toMatchObject({ actedBy: "owner@x.test", actionNote: "new VPS" });
    // The same reports, read again: they predate the answer.
    await service.runCycle(new Date(T0 + 30 * MIN));
    expect(world.incidents).toHaveLength(1);
  });

  it("after Retired, does not watch the server while it keeps that address", async () => {
    const { service, world } = build("record", blocked(T0));
    await service.runCycle(new Date(T0));
    await service.act(world.incidents[0].id, "retired", "owner@x.test", {}, new Date(T0 + MIN));
    world.attempts = blockedReports(T0 + 3 * DAY);
    const summaries = await service.runCycle(new Date(T0 + 3 * DAY));
    expect(summaries).toHaveLength(0);
    world.nodes[0].publicIp = "192.0.2.99";
    expect(await service.runCycle(new Date(T0 + 3 * DAY))).toHaveLength(1);
  });

  it("refuses an answer to a closed incident and a snooze out of range", async () => {
    const { service, world } = build("record", blocked(T0));
    await service.runCycle(new Date(T0));
    const id = world.incidents[0].id;
    await expect(service.act(id, "snooze", "o", { hours: 500 })).rejects.toThrow("Snooze for 1 to 168 hours");
    await service.act(id, "retired", "o");
    await expect(service.act(id, "keep", "o")).rejects.toThrow("already closed");
  });

  it("in digest mode sends one digest a day and no pages", async () => {
    const { service, world, pages } = build("digest", { ...blocked(T0), checks: unreachableChecks("n1", T0) });
    await service.runCycle(new Date(T0));
    expect(world.incidents[0].verdict).toBe("LIKELY_BLOCKED");
    expect(pages).toHaveLength(1);
    expect(pages[0].subject).toBe("[Neoxify] Block watch: 1 server under watch from IR");
    expect(pages[0].text).toContain("Calibration");
    world.attempts = blockedReports(T0 + 2 * HOUR);
    world.checks = unreachableChecks("n1", T0 + 2 * HOUR);
    await service.runCycle(new Date(T0 + 2 * HOUR));
    expect(pages).toHaveLength(1);
    world.attempts = blockedReports(T0 + 25 * HOUR);
    world.checks = unreachableChecks("n1", T0 + 25 * HOUR);
    await service.runCycle(new Date(T0 + 25 * HOUR));
    expect(pages).toHaveLength(2);
  });

  it("lists reachability alerts it held back in the digest", async () => {
    const { service, world, digests } = build("notify", blocked(T0));
    world.alerts.push({ nodeId: "n1", notifyError: HELD_FOR_BLOCK_WATCH, openedAt: new Date(T0 - 10 * MIN) });
    await service.runCycle(new Date(T0));
    expect(digests()[0].text).toContain("Reachability alerts not sent separately");
    expect(digests()[0].text).toContain("germany-1");
  });

  it("counts a traffic cliff from upstream bytes against the same hours on earlier days", async () => {
    const usage: World["usage"] = [];
    for (let day = 1; day <= 7; day += 1) {
      for (let s = 0; s < 10; s += 1) usage.push(["n1", `sub${s}`, T0 - day * DAY - 30 * MIN, 50_000]);
    }
    // Today: one real user, and nine whose upload is a trickle.
    usage.push(["n1", "sub0", T0 - 30 * MIN, 50_000]);
    for (let s = 1; s < 10; s += 1) usage.push(["n1", `sub${s}`, T0 - 30 * MIN, 1_000]);
    const { service, world } = build("record", { usage });
    await service.runCycle(new Date(T0));
    const traffic = world.incidents[0].evidenceJson.families.find((f: Row) => f.family === "traffic");
    expect(traffic).toMatchObject({ firing: true });
    expect(traffic.summary).toContain("1 people sent data");
    expect(traffic.summary).toContain("usually 10");
  });

  it("compares traffic with the days before the incident while it is open, so a lasting block never becomes usual", async () => {
    const usage: World["usage"] = [];
    for (let day = 1; day <= 14; day += 1) {
      for (let s = 0; s < 10; s += 1) usage.push(["n1", `sub${s}`, T0 - day * DAY - 30 * MIN, 50_000]);
    }
    for (let day = 0; day <= 6; day += 1) usage.push(["n1", "sub0", T0 + day * DAY - 30 * MIN, 50_000]);
    const { service, world } = build("record", { usage });
    await service.runCycle(new Date(T0));
    expect(world.incidents[0].firedFamilies).toEqual(["traffic"]);

    // Five days on, most of the last week is the block itself.
    await service.runCycle(new Date(T0 + 5 * DAY));
    const traffic = world.incidents[0].evidenceJson.families.find((f: Row) => f.family === "traffic");
    expect(traffic).toMatchObject({ firing: true });
    expect(traffic.summary).toContain("usually 10 at this time of day before this began");
    expect(world.incidents[0].status).toBe("OPEN");
  });
});

describe("trafficSince", () => {
  it("leaves out days before the owner's last answer", () => {
    const counts = new Map([[0, 2], [1, 9], [2, 9]]);
    const result = trafficSince(counts, T0, T0 - 36 * HOUR);
    expect(result.current).toBe(2);
    expect(result.baseline.slice(0, 3)).toEqual([9, null, null]);
    expect(result.beforeIncident).toBe(false);
  });

  it("starts from the given day while an incident is open", () => {
    const counts = new Map([[0, 1], [5, 1], [6, 10], [7, 10]]);
    const result = trafficSince(counts, T0, 0, DEFAULT_TUNING, 6);
    expect(result.baseline.slice(0, 2)).toEqual([10, 10]);
    expect(result.beforeIncident).toBe(true);
  });
});

describe("firstDayOf", () => {
  it("is the first day whose window ends before the incident, with a margin", () => {
    expect(firstDayOf(T0 - 30 * MIN, T0)).toBe(1);
    expect(firstDayOf(T0 - 23 * HOUR, T0)).toBe(2);
    expect(firstDayOf(T0 - 5 * DAY, T0)).toBe(6);
  });
});

describe("tcpReachable", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("is true for a port that accepts", async () => {
    expect(await tcpReachable("127.0.0.1", port, 2_000)).toBe(true);
  });

  it("is false for a port nobody listens on", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const freePort = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await tcpReachable("127.0.0.1", freePort, 2_000)).toBe(false);
  });
});
