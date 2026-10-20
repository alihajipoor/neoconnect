/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-call -- the in-memory
 * Prisma stand-in below reads untyped rows and answers like the real
 * client, asynchronously. */
import { createServer, type Server } from "node:net";
import { BlockWatchService, parseBlockWatchMode, tcpReachable, trafficSince, PAGES_PER_HOUR } from "./block-watch.service";

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
  /** usage: [nodeId, subscriptionId, reportedAt ms, bytesUp] */
  usage: [string, string, number, number][];
  incidents: Row[];
}

function fakePrisma(world: World) {
  let seq = 0;
  const withNode = (i: Row) => ({ ...i, node: { ...world.nodes.find((n) => n.id === i.nodeId) } });
  return {
    node: {
      findMany: jest.fn(async ({ where }: Row) => world.nodes.filter((n) => matches(n, where))),
    },
    blockIncident: {
      findMany: jest.fn(async ({ where, include, select, distinct }: Row) => {
        let rows = world.incidents.filter((i) => matches(i, where));
        if (distinct) {
          rows = [...rows].sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
          const seen = new Set<string>();
          rows = rows.filter((r) => (seen.has(r.nodeId) ? false : (seen.add(r.nodeId), true)));
        }
        return include || select?.node ? rows.map(withNode) : rows.map((r) => ({ ...r }));
      }),
      findUnique: jest.fn(async ({ where }: Row) => world.incidents.find((i) => i.id === where.id) ?? null),
      create: jest.fn(async ({ data }: Row) => {
        const row = {
          id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
          status: "OPEN",
          quietCycles: 0,
          pagedAt: null,
          pageError: null,
          remindedAt: null,
          recoveryNotifiedAt: null,
          digestedAt: null,
          keptAt: null,
          snoozedUntil: null,
          closedAt: null,
          likelyAt: null,
          actedBy: null,
          actionNote: null,
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
      findMany: jest.fn(async ({ where }: Row) =>
        world.attempts.filter((a) => a.createdAt.getTime() >= where.createdAt.gte.getTime()),
      ),
    },
    route: { findMany: jest.fn(async () => world.routes) },
    nodeReachabilityCheck: {
      findMany: jest.fn(async ({ where }: Row) =>
        world.checks
          .filter((c) => c.checkedAt.getTime() >= where.checkedAt.gte.getTime())
          .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime()),
      ),
    },
    usageRecord: {
      groupBy: jest.fn(async ({ where }: Row) => {
        const from = where.reportedAt.gte.getTime();
        const to = where.reportedAt.lt.getTime();
        const sums = new Map<string, number>();
        for (const [nodeId, sub, at, up] of world.usage) {
          if (at < from || at >= to) continue;
          const key = `${nodeId}|${sub}`;
          sums.set(key, (sums.get(key) ?? 0) + up);
        }
        return [...sums]
          .filter(([, up]) => up >= 20 * 1024)
          .map(([key]) => ({ nodeId: key.split("|")[0], subscriptionId: key.split("|")[1] }));
      }),
    },
  };
}

function build(mode: string, world: Partial<World> = {}) {
  const w: World = {
    nodes: [{ id: "n1", name: "germany-1", status: "ONLINE", publicIp: "192.0.2.10", realityDestReachable: true }],
    attempts: [],
    routes: [{ id: "r1", entryProtocolConfig: { nodeId: "n1", protocol: "XRAY_VLESS_REALITY" } }],
    checks: [],
    usage: [],
    incidents: [],
    ...world,
  };
  const prisma = fakePrisma(w);
  const config = {
    get: jest.fn((key: string) => ({ "blockWatch.mode": mode, "reachability.country": "ir", "reachability.port": 443 })[key]),
  };
  const identity = {
    countryOfAsn: jest.fn((asn: number) => (asn === FOREIGN_ASN ? "DE" : "IR")),
    orgOf: jest.fn(() => "Example Carrier"),
  };
  const pages: { subject: string; text: string }[] = [];
  const pager = {
    page: jest.fn(async (p: { subject: string; text: string }) => {
      pages.push(p);
      return { webhook: true, mailed: ["o@x.test"], failed: [], delivered: true, error: null };
    }),
  };
  const service = new BlockWatchService(prisma as never, config as never, identity as never, pager as never);
  service.tcpReachable = jest.fn(async () => true);
  /** Pages other than the daily digest. */
  const alerts = () => pages.filter((p) => !p.subject.startsWith("[Neoxify] Block watch:"));
  const digests = () => pages.filter((p) => p.subject.startsWith("[Neoxify] Block watch:"));
  return { service, world: w, prisma, pages, alerts, digests, pager, config };
}

/** Signed-in customers on `asn` who dialled route r1. */
function reports(asn: number, n: number, carried: boolean, at: number, prefix: string, routeId = "r1"): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    customerId: `${prefix}-${asn}-${i}`,
    asn,
    attemptsJson: [{ protocol: "Fast", result: carried ? "connected" : "up but unreachable", routeId, carried }],
    createdAt: new Date(at),
    occurredAt: null,
  }));
}

/** A week in which r1 worked on both networks, then a recent failure on both. */
function blockedByReports(now: number): Row[] {
  return [
    ...reports(ASN_A, 3, true, now - 2 * DAY, "base"),
    ...reports(ASN_B, 3, true, now - 2 * DAY, "base"),
    ...reports(ASN_A, 4, false, now - 20 * MIN, "now"),
    ...reports(ASN_B, 4, false, now - 20 * MIN, "now"),
  ];
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
    const { service, prisma } = build("off", { attempts: blockedByReports(T0) });
    expect(await service.runCycle(new Date(T0))).toEqual([]);
    expect(prisma.node.findMany).not.toHaveBeenCalled();
  });

  it("records without sending anything in record mode", async () => {
    const { service, world, pages } = build("record", { attempts: blockedByReports(T0) });
    await service.runCycle(new Date(T0));
    expect(world.incidents).toHaveLength(1);
    expect(world.incidents[0]).toMatchObject({ nodeId: "n1", status: "OPEN", verdict: "SUSPECT" });
    expect(pages).toHaveLength(0);
  });

  it("opens nothing from a single customer's report", async () => {
    const one = [...reports(ASN_A, 3, true, T0 - 2 * DAY, "base"), ...reports(ASN_A, 1, false, T0 - 10 * MIN, "now")];
    // The same customer reporting again and again is still one customer.
    const again = Array.from({ length: 10 }, (_, i) => ({ ...one[3], createdAt: new Date(T0 - i * MIN) }));
    const { service, world, pages } = build("notify", { attempts: [...one, ...again] });
    await service.runCycle(new Date(T0));
    expect(world.incidents).toHaveLength(0);
    expect(pages).toHaveLength(0);
  });

  it("ignores reports from networks outside the watched country, and relayed routes", async () => {
    const foreign = [
      ...reports(FOREIGN_ASN, 3, true, T0 - 2 * DAY, "base"),
      ...reports(FOREIGN_ASN, 5, false, T0 - 10 * MIN, "now"),
      ...reports(ASN_A, 3, true, T0 - 2 * DAY, "rbase", "relay-route"),
      ...reports(ASN_A, 5, false, T0 - 10 * MIN, "rnow", "relay-route"),
    ];
    const { service, world } = build("notify", { attempts: foreign });
    await service.runCycle(new Date(T0));
    expect(world.incidents).toHaveLength(0);
  });

  it("pages once when reports on two networks have lasted, never twice for one incident", async () => {
    const { service, world, alerts: pages, digests } = build("notify", { attempts: blockedByReports(T0) });
    await service.runCycle(new Date(T0));
    expect(world.incidents[0].verdict).toBe("SUSPECT");
    expect(pages()).toHaveLength(0);
    // A suspicion goes to the digest, not the pager.
    expect(digests()).toHaveLength(1);
    expect(digests()[0].text).toContain("germany-1 -- suspect");

    // Two cycles later, same evidence, now over an hour old.
    world.attempts = blockedByReports(T0 + 70 * MIN);
    await service.runCycle(new Date(T0 + 70 * MIN));
    expect(world.incidents[0].verdict).toBe("LIKELY_BLOCKED");
    expect(pages()).toHaveLength(1);
    expect(pages()[0].subject).toBe("[Neoxify] germany-1 is likely blocked from IR");
    expect(pages()[0].text).toContain("AS64500 (Example Carrier)");
    expect(pages()[0].text).not.toContain("192.0.2.10");
    expect(world.incidents[0].pagedAt).toEqual(new Date(T0 + 70 * MIN));

    world.attempts = blockedByReports(T0 + 100 * MIN);
    await service.runCycle(new Date(T0 + 100 * MIN));
    expect(pages()).toHaveLength(1);
    expect(digests()).toHaveLength(1);
    expect(world.incidents).toHaveLength(1);
  });

  it("pages at once when two signals agree", async () => {
    const { service, world, pages } = build("notify", {
      attempts: blockedByReports(T0),
      checks: unreachableChecks("n1", T0),
    });
    await service.runCycle(new Date(T0));
    expect(world.incidents[0].verdict).toBe("LIKELY_BLOCKED");
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toContain("independent signals agree");
    expect(pages[0].text).toContain("address or its port");
  });

  it("calls it an outage, not a block, when the port is dead from abroad too", async () => {
    const { service, world, pages } = build("notify", {
      attempts: blockedByReports(T0),
      checks: unreachableChecks("n1", T0),
    });
    service.tcpReachable = jest.fn(async () => false);
    const [summary] = await service.runCycle(new Date(T0));
    expect(summary.outage).toContain("not blocked");
    expect(world.incidents).toHaveLength(0);
    expect(pages).toHaveLength(0);
  });

  it("calls it an outage when the agent is offline, and holds an open incident rather than clearing it", async () => {
    const { service, world } = build("record", { attempts: blockedByReports(T0) });
    await service.runCycle(new Date(T0));
    world.nodes[0].status = "OFFLINE";
    world.attempts = [];
    for (let i = 1; i <= 3; i += 1) await service.runCycle(new Date(T0 + i * 30 * MIN));
    expect(world.incidents[0]).toMatchObject({ status: "OPEN", quietCycles: 0 });
    expect(world.incidents[0].evidenceJson.outage).toContain("offline");
  });

  it("clears after quiet cycles and tells the owner only if it had paged", async () => {
    const { service, world, pages } = build("notify", {
      attempts: blockedByReports(T0),
      checks: unreachableChecks("n1", T0),
    });
    await service.runCycle(new Date(T0));
    expect(pages).toHaveLength(1);
    world.attempts = [];
    world.checks = [];
    await service.runCycle(new Date(T0 + 30 * MIN));
    expect(world.incidents[0]).toMatchObject({ status: "OPEN", quietCycles: 1 });
    await service.runCycle(new Date(T0 + 60 * MIN));
    expect(world.incidents[0].status).toBe("CLEARED");
    expect(pages).toHaveLength(2);
    expect(pages[1].subject).toBe("[Neoxify] germany-1: no block signal any more");
    expect(world.incidents[0].recoveryNotifiedAt).toEqual(new Date(T0 + 60 * MIN));
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
    const attempts = nodes.flatMap((n) =>
      blockedByReports(T0).map((a) => ({
        ...a,
        customerId: `${a.customerId}-${n.id}`,
        attemptsJson: [{ ...a.attemptsJson[0], routeId: `r-${n.id}` }],
      })),
    );
    const checks = nodes.flatMap((n) => unreachableChecks(n.id, T0));
    const { service, world, pages } = build("notify", { nodes, routes, attempts, checks });
    await service.runCycle(new Date(T0));
    expect(world.incidents.filter((i) => i.verdict === "LIKELY_BLOCKED")).toHaveLength(3);
    expect(pages).toHaveLength(1);
    expect(pages[0].subject).toBe("[Neoxify] 3 servers look blocked from IR at once");
    expect(pages[0].text).toContain("international cut");
    expect(world.incidents.every((i) => i.pagedAt)).toBe(true);
  });

  it("holds pages over the hourly budget for the next cycle instead of dropping them", async () => {
    const { service, world, pages } = build("notify", {
      attempts: blockedByReports(T0),
      checks: unreachableChecks("n1", T0),
    });
    const budget = (service as unknown as { budget: { take(now: number): boolean } }).budget;
    for (let i = 0; i < PAGES_PER_HOUR; i += 1) budget.take(T0 - MIN);
    await service.runCycle(new Date(T0));
    expect(pages).toHaveLength(0);
    expect(world.incidents[0].pagedAt).toBeNull();

    world.attempts = blockedByReports(T0 + HOUR);
    world.checks = unreachableChecks("n1", T0 + HOUR);
    await service.runCycle(new Date(T0 + HOUR));
    expect(pages).toHaveLength(1);
  });

  it("reminds once after a day, unless the owner said keep", async () => {
    const run = async (keep: boolean) => {
      const { service, world, pages } = build("notify", {
        attempts: blockedByReports(T0),
        checks: unreachableChecks("n1", T0),
      });
      await service.runCycle(new Date(T0));
      if (keep) await service.act(world.incidents[0].id, "keep", "owner@x.test", {}, new Date(T0 + MIN));
      for (const at of [T0 + 25 * HOUR, T0 + 26 * HOUR]) {
        world.attempts = blockedByReports(at);
        world.checks = unreachableChecks("n1", at);
        await service.runCycle(new Date(at));
      }
      return pages;
    };
    const reminded = await run(false);
    expect(reminded.map((p) => p.subject)).toEqual([
      "[Neoxify] germany-1 is likely blocked from IR",
      "[Neoxify] Reminder: germany-1 still looks blocked from IR",
    ]);
    expect(await run(true)).toHaveLength(1);
  });

  it("holds the page while snoozed and sends it after", async () => {
    const { service, world, alerts } = build("notify", { attempts: blockedByReports(T0) });
    const pages = { get length() { return alerts().length; } };
    await service.runCycle(new Date(T0));
    await service.act(world.incidents[0].id, "snooze", "owner@x.test", { hours: 2 }, new Date(T0 + MIN));
    world.attempts = blockedByReports(T0 + 70 * MIN);
    await service.runCycle(new Date(T0 + 70 * MIN));
    expect(world.incidents[0].verdict).toBe("LIKELY_BLOCKED");
    expect(pages).toHaveLength(0);
    world.attempts = blockedByReports(T0 + 130 * MIN);
    await service.runCycle(new Date(T0 + 130 * MIN));
    expect(pages).toHaveLength(1);
  });

  it("after Replaced, starts over: old evidence no longer counts", async () => {
    const { service, world } = build("record", { attempts: blockedByReports(T0) });
    await service.runCycle(new Date(T0));
    const replaced = await service.act(world.incidents[0].id, "replaced", "owner@x.test", { note: "new VPS" }, new Date(T0 + MIN));
    expect(replaced.status).toBe("REPLACED");
    expect(world.incidents[0]).toMatchObject({ actedBy: "owner@x.test", actionNote: "new VPS" });
    // The same reports, read again: their baseline predates the answer.
    await service.runCycle(new Date(T0 + 30 * MIN));
    expect(world.incidents).toHaveLength(1);
  });

  it("after Retired, does not watch the server while it keeps that address", async () => {
    const { service, world } = build("record", { attempts: blockedByReports(T0) });
    await service.runCycle(new Date(T0));
    await service.act(world.incidents[0].id, "retired", "owner@x.test", {}, new Date(T0 + MIN));
    world.attempts = blockedByReports(T0 + 3 * DAY).map((a) => ({ ...a, createdAt: new Date(T0 + 3 * DAY - 10 * MIN) }));
    const summaries = await service.runCycle(new Date(T0 + 3 * DAY));
    expect(summaries).toHaveLength(0);
    world.nodes[0].publicIp = "192.0.2.99";
    expect(await service.runCycle(new Date(T0 + 3 * DAY))).toHaveLength(1);
  });

  it("refuses an answer to a closed incident and a snooze out of range", async () => {
    const { service, world } = build("record", { attempts: blockedByReports(T0) });
    await service.runCycle(new Date(T0));
    const id = world.incidents[0].id;
    await expect(service.act(id, "snooze", "o", { hours: 500 })).rejects.toThrow("Snooze for 1 to 168 hours");
    await service.act(id, "retired", "o");
    await expect(service.act(id, "keep", "o")).rejects.toThrow("already closed");
  });

  it("in digest mode sends one digest a day and no pages", async () => {
    const { service, world, pages } = build("digest", {
      attempts: blockedByReports(T0),
      checks: unreachableChecks("n1", T0),
    });
    await service.runCycle(new Date(T0));
    expect(world.incidents[0].verdict).toBe("LIKELY_BLOCKED");
    expect(pages).toHaveLength(1);
    expect(pages[0].subject).toBe("[Neoxify] Block watch: 1 server under watch from IR");
    expect(pages[0].text).toContain("Calibration");
    world.attempts = blockedByReports(T0 + 2 * HOUR);
    world.checks = unreachableChecks("n1", T0 + 2 * HOUR);
    await service.runCycle(new Date(T0 + 2 * HOUR));
    expect(pages).toHaveLength(1);
    world.attempts = blockedByReports(T0 + 25 * HOUR);
    world.checks = unreachableChecks("n1", T0 + 25 * HOUR);
    await service.runCycle(new Date(T0 + 25 * HOUR));
    expect(pages).toHaveLength(2);
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
});

describe("trafficSince", () => {
  it("leaves out days before the owner's last answer", () => {
    const counts = new Map([[0, 2], [1, 9], [2, 9]]);
    const result = trafficSince(counts, T0, T0 - 36 * HOUR);
    expect(result.current).toBe(2);
    expect(result.baseline.slice(0, 3)).toEqual([9, null, null]);
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
