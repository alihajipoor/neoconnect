/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-require-imports --
 * the in-memory Prisma stand-in below reads untyped rows and answers like
 * the real client, asynchronously; the service under replay is loaded by
 * path so an older copy of it can be replayed the same way. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Replays the block watch, the real service and its real rules, over rows
 * exported from production, every 30 minutes as the sweep runs it, and
 * writes what it would have opened and sent.
 *
 * Skipped unless BLOCK_WATCH_REPLAY names the rows file (tab-separated,
 * one row per line, the first field its kind -- NODE, ROUTE, INC, IN, PR,
 * SUB, CA, U -- as `load` below reads them; made by a read-only export
 * kept with the rows, never in this repository). Customer and
 * subscription ids in it are short hashes; it holds no addresses. Options, all by environment:
 *
 *   BLOCK_WATCH_REPLAY_SERVICE  a path to another block-watch.service to
 *                               replay instead (an older copy, to compare)
 *   BLOCK_WATCH_REPLAY_OUT      where to write the result (JSON)
 *   BLOCK_WATCH_REPLAY_FROM     the first evaluation (ISO), default the
 *                               first inside-probe round
 *   BLOCK_WATCH_REPLAY_TUNING   BLOCK_WATCH_TUNING to replay with
 *   BLOCK_WATCH_REPLAY_ASNS     networks in the country, comma-separated
 *                               (the network table is not in the database)
 *
 *   BLOCK_WATCH_REPLAY=rows.tsv npx jest block-watch.replay
 *
 * What it cannot know is set as follows, and said in its output: every
 * server's port answers from the panel host, every camouflage destination
 * is up, a server is in service from its creation until it was retired
 * (its last update, for one that is DISABLED now), a node whose agent is
 * offline now went offline at its last heartbeat, the owner's answers are
 * applied at the time they were given, and every message is delivered. */
const ROWS = process.env.BLOCK_WATCH_REPLAY;
const describeReplay = ROWS ? describe : describe.skip;

type Row = Record<string, any>;
const MIN = 60_000;

/** The first index in `sorted` (by `key`) at or after `t`. */
function lowerBound<T>(sorted: T[], key: (x: T) => number, t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(sorted[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const ms = (x: unknown): number => (x instanceof Date ? x.getTime() : Number(x));

/** Just enough of a where clause for the incident queries the service makes. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (key === "node") return matches((value as Row | undefined) ?? {}, cond as Row);
    if (typeof cond === "object" && !Array.isArray(cond)) {
      if ("in" in cond && !cond.in.includes(value)) return false;
      if ("not" in cond) {
        if (cond.not === null ? value === null || value === undefined : typeof cond.not === "object" ? matches({ [key]: value }, { [key]: cond.not }) : value === cond.not)
          return false;
      }
      const t = value instanceof Date ? value.getTime() : value;
      if ("gte" in cond && !(t !== null && t !== undefined && t >= ms(cond.gte))) return false;
      if ("gt" in cond && !(t !== null && t !== undefined && t > ms(cond.gt))) return false;
      if ("lte" in cond && !(t !== null && t !== undefined && t <= ms(cond.lte))) return false;
      if ("lt" in cond && !(t !== null && t !== undefined && t < ms(cond.lt))) return false;
      return true;
    }
    return value === cond;
  });
}

interface Data {
  dataEnd: number;
  nodes: Row[];
  routes: Row[];
  answers: { nodeId: string; status: string; closedAt: number }[];
  inside: Row[];
  probes: Row[];
  subs: Row[];
  attempts: Row[];
  /** [nodeId, subscription, reportedAt, up, down], by time. */
  usage: [string, string, number, number, number][];
}

function load(path: string): Data {
  const d: Data = { dataEnd: 0, nodes: [], routes: [], answers: [], inside: [], probes: [], subs: [], attempts: [], usage: [] };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const f = line.replace(/\r$/, "").split("\t");
    switch (f[0]) {
      case "NOW":
        d.dataEnd = Number(f[1]);
        break;
      case "NODE":
        d.nodes.push({ id: f[1], name: f[2], role: f[3], statusNow: f[4], createdAt: Number(f[5]), updatedAt: Number(f[6]), lastHeartbeatAt: Number(f[7]) });
        break;
      case "ROUTE":
        d.routes.push({ id: f[1], entryProtocolConfig: { nodeId: f[2], protocol: f[3] } });
        break;
      case "INC":
        if (f[2] === "RETIRED" || f[2] === "REPLACED") d.answers.push({ nodeId: f[1], status: f[2], closedAt: Number(f[4]) });
        break;
      case "IN": {
        const connectMs = Number(f[3]);
        d.inside.push({
          nodeId: f[1],
          vantage: f[2],
          connectMs: connectMs < 0 ? null : connectMs,
          downBytes: Number(f[4]),
          upBytes: Number(f[5]),
          upMs: Number(f[6]),
          verdict: f[7],
          checkedAt: new Date(Number(f[8])),
        });
        break;
      }
      case "PR":
        d.probes.push({
          nodeId: f[1],
          verdict: f[2],
          checkedAt: new Date(Number(f[3])),
          detailJson: (f[4] ?? "")
            .split(",")
            .filter(Boolean)
            .map((x) => {
              const [asn, ok] = x.split(":");
              return { asn, ok: ok === "true" };
            }),
        });
        break;
      case "SUB":
        d.subs.push({ id: f[1], customerId: f[2] });
        break;
      case "CA":
        d.attempts.push({
          customerId: f[1],
          asn: Number(f[2]),
          createdAt: new Date(Number(f[3])),
          occurredAt: Number(f[4]) ? new Date(Number(f[4])) : null,
          attemptsJson: (f[5] ?? "")
            .split(",")
            .filter(Boolean)
            .map((x) => {
              const i = x.lastIndexOf(":");
              return { routeId: x.slice(0, i), carried: x.slice(i + 1) === "true" };
            }),
        });
        break;
      case "U":
        d.usage.push([f[1], f[2], Number(f[3]), Number(f[4]), Number(f[5])]);
        break;
    }
  }
  d.inside.sort((a, b) => a.checkedAt - b.checkedAt);
  d.probes.sort((a, b) => a.checkedAt - b.checkedAt);
  d.attempts.sort((a, b) => a.createdAt - b.createdAt);
  d.usage.sort((a, b) => a[2] - b[2]);
  return d;
}

function fakePrisma(d: Data, clock: { now: number }) {
  let seq = 0;
  const incidents: Row[] = [];
  const notices: Row[] = [];
  /** A node as it stood at the replay's "now": not yet created is absent;
   * one retired is DISABLED from its last update; one offline now went
   * offline at its last heartbeat. */
  const nodesNow = () =>
    d.nodes
      .filter((n) => n.createdAt <= clock.now)
      .map((n) => ({
        id: n.id,
        name: n.name,
        publicIp: `addr-${n.id.slice(0, 8)}`,
        realityDestReachable: true,
        status:
          n.statusNow === "DISABLED" && n.updatedAt <= clock.now
            ? "DISABLED"
            : n.statusNow === "OFFLINE" && n.lastHeartbeatAt <= clock.now
              ? "OFFLINE"
              : "ONLINE",
      }));
  const nodeById = () => new Map(nodesNow().map((n) => [n.id, n]));
  const withNode = (i: Row) => ({ ...i, node: { ...(nodeById().get(i.nodeId) ?? { status: "DISABLED", name: "?" }) } });
  const between = <T>(sorted: T[], key: (x: T) => number, from: number, to: number) =>
    sorted.slice(lowerBound(sorted, key, from), lowerBound(sorted, key, to + 1));

  return {
    incidents,
    notices,
    node: { findMany: async ({ where }: Row) => nodesNow().filter((n) => matches(n, where)) },
    blockIncident: {
      findMany: async ({ where, include, select, distinct, orderBy }: Row) => {
        let rows = incidents.filter((i) => matches(withNode(i), where));
        if (orderBy?.closedAt === "desc") rows = [...rows].sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
        if (distinct) {
          const seen = new Set<string>();
          rows = rows.filter((r) => (seen.has(r.nodeId) ? false : (seen.add(r.nodeId), true)));
        }
        return include || select?.node ? rows.map(withNode) : rows.map((r) => ({ ...r }));
      },
      findUnique: async ({ where }: Row) => {
        const row = incidents.find((i) => i.id === where.id);
        return row ? withNode(row) : null;
      },
      create: async ({ data }: Row) => {
        const row = {
          id: `incident-${++seq}`,
          status: "OPEN",
          quietCycles: 0,
          pagedAt: null,
          pageError: null,
          pageAttempts: 0,
          insideNoticedAt: null,
          insideNoticeError: null,
          insideNoticeAttempts: 0,
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
        incidents.push(row);
        return row;
      },
      update: async ({ where, data }: Row) => Object.assign(incidents.find((i) => i.id === where.id)!, data),
      updateMany: async ({ where, data }: Row) => {
        const rows = incidents.filter((i) => matches(i, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      count: async ({ where }: Row) => incidents.filter((i) => matches(i, where)).length,
      aggregate: async ({ where }: Row) => {
        const times = incidents.filter((i) => matches(i, where) && i.digestedAt).map((i) => i.digestedAt.getTime());
        return { _max: { digestedAt: times.length ? new Date(Math.max(...times)) : null } };
      },
    },
    clientAttempt: {
      groupBy: async ({ where }: Row) => [
        ...new Set(between(d.attempts, (a) => a.createdAt.getTime(), ms(where.createdAt.gte), clock.now).map((a) => a.asn)),
      ].map((asn) => ({ asn })),
    },
    // latestDialsSql, as Postgres answers it.
    $queryRaw: async (sql: { values: unknown[] }) => {
      const [sinceMs, ...asns] = sql.values as number[];
      const best = new Map<string, Row>();
      for (const a of between(d.attempts, (x) => x.createdAt.getTime(), sinceMs, clock.now)) {
        if (!asns.includes(a.asn)) continue;
        const arrived = a.createdAt.getTime();
        const said = a.occurredAt?.getTime();
        const happened = said !== undefined && said <= arrived ? said : arrived;
        (a.attemptsJson as Row[]).forEach((rung, i) => {
          const row = { customerId: a.customerId, asn: a.asn, routeId: rung.routeId, carried: rung.carried, happenedAt: new Date(happened), createdAt: a.createdAt, rung: i + 1 };
          const key = `${a.customerId}|${a.asn}|${rung.routeId}`;
          const held = best.get(key);
          const later = held ? happened - held.happenedAt.getTime() || arrived - held.createdAt.getTime() || row.rung - held.rung : 1;
          if (later > 0) best.set(key, row);
        });
      }
      return [...best.values()];
    },
    route: { findMany: async () => d.routes },
    subscription: { findMany: async ({ where }: Row) => d.subs.filter((s) => matches(s, where)) },
    nodeReachabilityCheck: {
      findMany: async ({ where }: Row) =>
        between(d.probes, (c) => c.checkedAt.getTime(), ms(where.checkedAt.gte), clock.now).reverse(),
    },
    insideProbeCheck: {
      findMany: async ({ where, select }: Row) => {
        const rows = between(d.inside, (c) => c.checkedAt.getTime(), ms(where.checkedAt.gte), clock.now);
        if (!select?.node) return rows;
        const names = new Map(d.nodes.map((n) => [n.id, n.name]));
        return rows.map((r) => ({ ...r, node: { name: names.get(r.nodeId) } }));
      },
      groupBy: async ({ where }: Row) => {
        const latest = new Map<string, number>();
        for (const r of between(d.inside, (c) => c.checkedAt.getTime(), ms(where.checkedAt.gte), clock.now)) {
          latest.set(r.vantage, Math.max(latest.get(r.vantage) ?? 0, r.checkedAt.getTime()));
        }
        return [...latest].map(([vantage, at]) => ({ vantage, _max: { checkedAt: new Date(at) } }));
      },
    },
    nodeReachabilityAlert: { findMany: async () => [] },
    blockWatchNotice: {
      findMany: async ({ where }: Row) =>
        notices.filter((n) => matches(n, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      create: async ({ data }: Row) => {
        const row = { id: `notice-${++seq}`, vantage: null, lastRoundAt: null, error: null, ...data };
        notices.push(row);
        return row;
      },
    },
    usageRecord: {
      groupBy: async ({ by, where, having }: Row) => {
        const nodeIds: string[] = where.nodeId.in;
        const subs: string[] | undefined = where.subscriptionId?.in;
        const end = Math.min(ms(where.reportedAt.lt), clock.now);
        const rows = between(d.usage, (u) => u[2], ms(where.reportedAt.gte), end - 1);
        const sums = new Map<string, [string, string, number, number]>();
        for (const [nodeId, sub, , up, down] of rows) {
          if (!nodeIds.includes(nodeId) || (subs && !subs.includes(sub))) continue;
          const key = by.length === 1 ? nodeId : `${nodeId}|${sub}`;
          const held = sums.get(key) ?? [nodeId, sub, 0, 0];
          held[2] += up;
          held[3] += down;
          sums.set(key, held);
        }
        return [...sums.values()]
          .filter(([, , up]) => !having || up >= having.bytesUp._sum.gte)
          .map(([nodeId, subscriptionId, up, down]) =>
            by.length === 1
              ? { nodeId, _sum: { bytesUp: BigInt(up), bytesDown: BigInt(down) } }
              : { nodeId, subscriptionId, _sum: { bytesUp: BigInt(up) } },
          );
      },
    },
    // The replay never reaches past the 35 days of detail kept.
    usageHourly: { groupBy: async () => [] },
  };
}

describeReplay("block watch replay", () => {
  it("replays the period and writes what it would have done", async () => {
    const servicePath = resolve(process.env.BLOCK_WATCH_REPLAY_SERVICE ?? `${__dirname}/block-watch.service`);
    const { BlockWatchService } = require(servicePath);
    const d = load(ROWS!);
    const clock = { now: 0 };
    const prisma = fakePrisma(d, clock);
    const asns = new Set((process.env.BLOCK_WATCH_REPLAY_ASNS ?? "").split(",").filter(Boolean).map(Number));
    const settings: Record<string, unknown> = {
      "blockWatch.mode": "notify",
      "blockWatch.tuning": process.env.BLOCK_WATCH_REPLAY_TUNING ?? "",
      "reachability.country": "ir",
      "reachability.port": 443,
    };
    const identity = {
      countryOfAsn: (asn: number) => (asns.has(asn) ? "IR" : "ZZ"),
      orgOf: () => null,
      networksKnown: () => true,
    };
    const sent: { at: string; event: string; subject: string; webhook: string }[] = [];
    const pager = {
      page: async (p: Row) => {
        sent.push({ at: new Date(clock.now).toISOString(), event: p.context?.event ?? "", subject: p.subject, webhook: p.webhook });
        return { webhook: true, mailed: ["owner"], failed: [], delivered: true, error: null };
      },
    };
    const service = new BlockWatchService(prisma as never, { get: (k: string) => settings[k] } as never, identity as never, pager as never);
    service.tcpReachable = async () => true;
    // Silence the service's own log lines over a month of evaluations.
    (service as Row).logger = { log: () => undefined, warn: () => undefined, error: (m: string) => console.error(m) };

    const firstRound = d.inside[0]?.checkedAt.getTime() ?? d.dataEnd;
    const from = process.env.BLOCK_WATCH_REPLAY_FROM ? Date.parse(process.env.BLOCK_WATCH_REPLAY_FROM) : firstRound;
    // On the sweep's own cadence: every 30 minutes, a minute past.
    let t = Math.ceil((from - MIN) / (30 * MIN)) * 30 * MIN + MIN;
    const states: Row[] = [];
    const last = new Map<string, string>();
    for (; t <= d.dataEnd; t += 30 * MIN) {
      clock.now = t;
      // The owner's answers, at the time he gave them.
      for (const a of d.answers) {
        if (a.closedAt > t) continue;
        for (const i of prisma.incidents) {
          if (i.nodeId === a.nodeId && i.status === "OPEN" && i.openedAt.getTime() <= a.closedAt) {
            Object.assign(i, { status: a.status, closedAt: new Date(a.closedAt), actedBy: "replay" });
          }
        }
      }
      const summaries: Row[] = await service.runCycle(new Date(t));
      for (const s of summaries) {
        const key = s.verdict ? `${s.verdict}[${s.firing.join("+")}]` : s.outage ? `outage(${s.outageKind ?? "?"})` : "";
        if ((last.get(s.nodeName) ?? "") !== key) {
          const inc = prisma.incidents.find((i) => i.status === "OPEN" && d.nodes.find((n) => n.id === i.nodeId)?.name === s.nodeName);
          const inside = inc?.evidenceJson?.families?.find((f: Row) => f.family === "inside");
          const bytes = inc?.evidenceJson?.families?.find((f: Row) => f.family === "bytes");
          states.push({
            at: new Date(t).toISOString(),
            node: s.nodeName,
            reading: key || "quiet",
            scope: inside?.firing ? (inside.scope?.text ?? inside.summary) : null,
            bytes: bytes?.summary ?? null,
            reports24h: inc?.evidenceJson?.reports24h ?? null,
          });
          last.set(s.nodeName, key);
        }
      }
    }
    const names = new Map(d.nodes.map((n) => [n.id, n.name]));
    const out = {
      service: servicePath,
      from: new Date(from).toISOString(),
      to: new Date(t - 30 * MIN).toISOString(),
      assumptions:
        "ports answer from the panel host; camouflage destinations up; servers in service from creation to retirement; " +
        "offline agents went offline at their last heartbeat; owner answers at their real times; every message delivered",
      incidents: prisma.incidents.map((i) => ({
        node: names.get(i.nodeId),
        openedAt: i.openedAt.toISOString(),
        likelyAt: i.likelyAt?.toISOString() ?? null,
        status: i.status,
        closedAt: i.closedAt?.toISOString() ?? null,
        verdict: i.verdict,
        firedFamilies: i.firedFamilies,
        pagedAt: i.pagedAt?.toISOString() ?? null,
        insideNoticedAt: i.insideNoticedAt?.toISOString() ?? null,
        lastReading: i.evidenceJson?.families?.filter((f: Row) => f.family === "inside" || f.family === "bytes").map((f: Row) => f.summary) ?? [],
      })),
      states,
      sent,
      notices: prisma.notices.map((n) => ({ kind: n.kind, vantage: n.vantage, at: n.createdAt.toISOString() })),
    };
    if (process.env.BLOCK_WATCH_REPLAY_OUT) writeFileSync(process.env.BLOCK_WATCH_REPLAY_OUT, JSON.stringify(out, null, 1));
    console.log(
      JSON.stringify(
        { incidents: out.incidents, sent: sent.reduce<Record<string, number>>((n, s) => ({ ...n, [s.event]: (n[s.event] ?? 0) + 1 }), {}) },
        null,
        1,
      ),
    );
    expect(t).toBeGreaterThan(from);
  }, 3_600_000);
});
