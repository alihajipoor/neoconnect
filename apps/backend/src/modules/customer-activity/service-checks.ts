import type { Prisma } from "@prisma/client";
import { serviceCheckLabel, SERVICE_CHECK_TARGETS } from "../client-attempts/service-check-targets";
import type { InsightDeviceFacts, InsightServiceChecks, InsightServiceResult, ServiceChecksSummary } from "./customer-insight.types";

/** Reading the stored `details` objects (docs/client-diagnostics.md) back
 * into counts. Pure, so the insight and the fleet summary count alike.
 *
 * Read defensively: the intake validated every row, but rows outlive the
 * code that wrote them, and a page should show an odd row as what it is
 * rather than break. Nothing here guesses a cause: every figure is a
 * count of what the apps reported. */

const iso = (ms: number) => new Date(ms).toISOString();

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A stored details object, or null. */
export function parseDetails(json: Prisma.JsonValue | null | undefined): Obj | null {
  return isObj(json) ? json : null;
}

export interface ParsedService {
  key: string;
  host: string;
  ok: boolean;
  stage: string;
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  firstByteMs: number | null;
  status: number | null;
  address: string | null;
  error: string | null;
}

/** The service results a details object carries. */
export function parseServices(details: Obj | null): ParsedService[] {
  if (!details || !Array.isArray(details.services)) return [];
  const out: ParsedService[] = [];
  for (const s of details.services) {
    if (!isObj(s) || typeof s.key !== "string" || typeof s.host !== "string" || typeof s.ok !== "boolean") continue;
    out.push({
      key: s.key,
      host: s.host,
      ok: s.ok,
      stage: str(s.stage) ?? "",
      dnsMs: num(s.dnsMs),
      connectMs: num(s.connectMs),
      tlsMs: num(s.tlsMs),
      firstByteMs: num(s.firstByteMs),
      status: num(s.status),
      address: str(s.address),
      error: str(s.error),
    });
  }
  return out;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** One report as these functions read it. */
export interface DetailRow {
  kind: string;
  platform: string;
  sessionId: string | null;
  routeId: string | null;
  protocol: string | null;
  /** When it happened, ms. */
  at: number;
  details: Obj | null;
}

/** Each device's newest facts, from rows newest first. Grouped by the
 * session a report named, else by platform. A device with no details in
 * the window is not listed: there is nothing to show for it. */
export function deviceFactsFrom(rows: DetailRow[], labelOf: Map<string, string | null>): InsightDeviceFacts[] {
  const groups = new Map<string, InsightDeviceFacts>();
  for (const r of rows) {
    if (!r.details) continue;
    const key = r.sessionId ? `s:${r.sessionId}` : `p:${r.platform}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        sessionId: r.sessionId,
        platform: r.platform,
        label: r.sessionId ? (labelOf.get(r.sessionId) ?? null) : null,
        lastSeenAt: iso(r.at),
        device: null,
        net: null,
        tunnel: null,
      };
      groups.set(key, g);
    }
    // Rows are newest first: the first of each part seen is the newest.
    if (g.device === null && isObj(r.details.device)) g.device = r.details.device;
    if (g.net === null && isObj(r.details.net)) g.net = r.details.net;
    if (g.tunnel === null && isObj(r.details.tunnel)) g.tunnel = r.details.tunnel;
  }
  return [...groups.values()];
}

/** The server a run went through, or null for a run outside the tunnel. */
function runServer(r: DetailRow, serverOf: Map<string, string>): { server: string | null; protocol: string | null; via: string | null } {
  const via = str(r.details?.via);
  if (via === "direct") return { server: null, protocol: null, via };
  return { server: r.routeId ? (serverOf.get(r.routeId) ?? null) : null, protocol: r.protocol, via };
}

/** One customer's service checks in the window, from rows newest first. */
export function serviceChecksFrom(rows: DetailRow[], serverOf: Map<string, string>): InsightServiceChecks {
  const runs = rows.filter((r) => r.kind === "SERVICE_CHECK");
  const latest = new Map<string, InsightServiceResult>();
  const byServer = new Map<string, InsightServiceChecks["byServer"][number] & { per: Map<string, { ok: number; failed: number }> }>();
  for (const r of runs) {
    const where = runServer(r, serverOf);
    const groupKey = `${where.server ?? ""}\u0000${where.protocol ?? ""}`;
    let g = byServer.get(groupKey);
    if (!g) {
      g = { server: where.server, protocol: where.protocol, runs: 0, perService: [], per: new Map() };
      byServer.set(groupKey, g);
    }
    g.runs += 1;
    for (const s of parseServices(r.details)) {
      if (!latest.has(s.key)) {
        latest.set(s.key, {
          key: s.key,
          label: serviceCheckLabel(s.key),
          host: s.host,
          ok: s.ok,
          stage: s.stage,
          dnsMs: s.dnsMs,
          connectMs: s.connectMs,
          tlsMs: s.tlsMs,
          firstByteMs: s.firstByteMs,
          status: s.status,
          address: s.address,
          error: s.error,
          at: iso(r.at),
          ...where,
        });
      }
      const c = g.per.get(s.key) ?? { ok: 0, failed: 0 };
      if (s.ok) c.ok += 1;
      else c.failed += 1;
      g.per.set(s.key, c);
    }
  }
  return {
    lastRunAt: runs[0] ? iso(runs[0].at) : null,
    runs: runs.length,
    latest: [...latest.values()],
    byServer: [...byServer.values()]
      .map(({ per, ...g }) => ({ ...g, perService: [...per].map(([key, c]) => ({ key, ...c })) }))
      .sort((a, b) => b.runs - a.runs),
  };
}

/** One SERVICE_CHECK report as the fleet summary reads it. */
export interface FleetRow {
  customerId: string | null;
  routeId: string | null;
  protocol: string | null;
  asn: number | null;
  details: Obj | null;
}

/** The 15 networks with the most runs. */
export const SUMMARY_NETWORKS = 15;

interface Tally {
  ok: number;
  failed: number;
  tls: number[];
  firstByte: number[];
  failStages: Map<string, number>;
}

function topStage(stages: Map<string, number>): string | null {
  let best: string | null = null;
  let count = 0;
  for (const [stage, n] of stages) {
    if (n > count || (n === count && best !== null && stage < best)) {
      best = stage;
      count = n;
    }
  }
  return best;
}

/** GET /service-checks/summary, from the window's SERVICE_CHECK rows. */
export function fleetSummary(
  hours: number,
  rows: FleetRow[],
  serverOf: Map<string, string>,
  network: (asn: number) => { name: string | null; country: string | null },
): ServiceChecksSummary {
  const customers = new Set<string>();
  const servers = new Map<string, { server: string | null; protocol: string | null; runs: number; customers: Set<string>; per: Map<string, Tally> }>();
  const networks = new Map<number, { runs: number; customers: Set<string>; per: Map<string, { ok: number; failed: number }> }>();

  for (const r of rows) {
    if (r.customerId) customers.add(r.customerId);
    const services = parseServices(r.details);

    if (r.asn !== null) {
      const n = networks.get(r.asn) ?? { runs: 0, customers: new Set<string>(), per: new Map() };
      n.runs += 1;
      if (r.customerId) n.customers.add(r.customerId);
      for (const s of services) {
        const c = n.per.get(s.key) ?? { ok: 0, failed: 0 };
        if (s.ok) c.ok += 1;
        else c.failed += 1;
        n.per.set(s.key, c);
      }
      networks.set(r.asn, n);
    }

    // Only runs made through the tunnel say anything about a server: a
    // direct run tested the customer's own line, and counting it under
    // whatever route the report named would blame a server it never used.
    if (str(r.details?.via) !== "tunnel") continue;
    const server = r.routeId ? (serverOf.get(r.routeId) ?? null) : null;
    const key = `${server ?? ""}\u0000${r.protocol ?? ""}`;
    const g = servers.get(key) ?? { server, protocol: r.protocol, runs: 0, customers: new Set<string>(), per: new Map() };
    g.runs += 1;
    if (r.customerId) g.customers.add(r.customerId);
    for (const s of services) {
      const t = g.per.get(s.key) ?? { ok: 0, failed: 0, tls: [], firstByte: [], failStages: new Map() };
      if (s.ok) t.ok += 1;
      else {
        t.failed += 1;
        t.failStages.set(s.stage, (t.failStages.get(s.stage) ?? 0) + 1);
      }
      if (s.tlsMs !== null) t.tls.push(s.tlsMs);
      if (s.firstByteMs !== null) t.firstByte.push(s.firstByteMs);
      g.per.set(s.key, t);
    }
    servers.set(key, g);
  }

  return {
    hours,
    runs: rows.length,
    customers: customers.size,
    targets: SERVICE_CHECK_TARGETS.map((t) => ({ key: t.key, label: t.label, host: t.host })),
    byServer: [...servers.values()]
      .map((g) => ({
        server: g.server,
        protocol: g.protocol,
        runs: g.runs,
        customers: g.customers.size,
        perService: [...g.per].map(([key, t]) => ({
          key,
          ok: t.ok,
          failed: t.failed,
          medianTlsMs: median(t.tls),
          medianFirstByteMs: median(t.firstByte),
          topFailStage: topStage(t.failStages),
        })),
      }))
      .sort((a, b) => b.runs - a.runs),
    byNetwork: [...networks]
      .sort((a, b) => b[1].runs - a[1].runs || a[0] - b[0])
      .slice(0, SUMMARY_NETWORKS)
      .map(([asn, n]) => ({
        asn,
        ...network(asn),
        runs: n.runs,
        customers: n.customers.size,
        perService: [...n.per].map(([key, c]) => ({ key, ...c })),
      })),
  };
}
