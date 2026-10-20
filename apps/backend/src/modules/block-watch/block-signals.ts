/** Whether a server looks blocked from the watched country, from what the
 * backend already records. Pure functions; BlockWatchService loads the
 * data and acts on the answer.
 *
 * Three independent kinds of evidence ("families"):
 *
 * * client -- the apps' own connect reports: per network, whether the
 *   people who dialled this server recently got traffic through, against
 *   whether it carried for people on that network before;
 * * traffic -- how many people sent data through the server lately,
 *   against the same time of day on the days before;
 * * probe -- the third-party TCP probes from inside the country that the
 *   reachability monitor already runs.
 *
 * One family on its own is a suspicion. A page needs two that agree, or
 * one that is broad and has lasted. A server that is down is an outage,
 * not a block, and is never reported as one. */

export type Family = "client" | "traffic" | "probe";
export const FAMILIES: readonly Family[] = ["client", "traffic", "probe"];

export type Verdict = "SUSPECT" | "LIKELY_BLOCKED";

/** The best guess at what kind of block it is.
 * address: TCP to the port fails from inside, works from outside.
 * protocol: some protocols on the server carry and others do not.
 * tunnel: TCP opens, but tunnels carry nothing (handshake, name or
 * upload filtering -- these cannot be told apart from here). */
export type BlockType = "address" | "protocol" | "tunnel";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Windows.
export const RECENT_MS = 3 * HOUR;
export const BASELINE_MS = 7 * DAY;
export const TRAFFIC_WINDOW_MS = 2 * HOUR;
export const PROBE_FRESH_MS = 3 * HOUR;

// Client reports.
export const MIN_FAILED_PER_NETWORK = 3;
export const MIN_BASELINE_PER_NETWORK = 2;
export const MAX_CARRIED_SHARE = 0.25;
export const THIN_CUSTOMERS = 3;

// Traffic.
export const UPSTREAM_ACTIVE_BYTES = 20 * 1024;
export const MIN_BASELINE_DAYS = 3;
export const TRAFFIC_MIN_BASELINE = 5;
export const TRAFFIC_CLIFF_SHARE = 0.3;

// Probes.
export const PROBE_STREAK = 2;

// Verdicts.
export const NETWORKS_FOR_LIKELY = 2;
export const CLIENT_SUSTAIN_MS = 1 * HOUR;
export const PROBE_ALONE_MS = 6 * HOUR;
export const QUIET_CYCLES_TO_CLEAR = 2;

export interface NetworkFinding {
  /** 0 when the probe service did not say. */
  asn: number;
  org: string | null;
  /** Customers (client) or vantages (probe) heard from. */
  tried: number;
  failed: number;
  /** Customers it carried for there in the baseline window (client only). */
  baseline: number | null;
  failing: boolean;
}

export interface FamilyResult {
  family: Family;
  firing: boolean;
  /** Too little data to say anything either way. */
  thin: boolean;
  /** When the condition began, where the data says (ms). */
  onset: number | null;
  /** One line for a person. */
  summary: string;
  networks: NetworkFinding[];
  /** client: protocols that carried for the failing networks, and ones
   * that only failed. */
  carriedProtocols?: string[];
  failedProtocols?: string[];
  /** probe: whether the latest conclusive probe opened TCP anywhere. */
  tcpOpen?: boolean | null;
}

/** One dial of a direct route into this server, from a report. */
export interface NodeDial {
  customerId: string;
  asn: number;
  carried: boolean;
  /** When it happened (ms), never later than the report's arrival. */
  at: number;
  protocol: string | null;
}

/** The apps' reports, per network. A network counts as failing when
 * several distinct customers on it dialled recently and nearly all got
 * nothing through, and the server did carry for people on that network
 * in the days before -- a network it never worked on is not a new block.
 * Counted by each customer's latest dial, so retries count once. */
export function clientFamily(
  dials: NodeDial[],
  now: number,
  floor: number,
  orgOf: (asn: number) => string | null = () => null,
): FamilyResult {
  const recentStart = Math.max(now - RECENT_MS, floor);
  const baselineStart = Math.max(now - BASELINE_MS, floor);

  // Stable sort: dials of one report keep their ladder order, so the last
  // rung on this server is the customer's latest dial.
  const ordered = dials.filter((d) => d.at >= baselineStart && d.at <= now).sort((a, b) => a.at - b.at);

  const latest = new Map<number, Map<string, NodeDial>>();
  const recentDials = new Map<number, NodeDial[]>();
  const baseline = new Map<number, Set<string>>();
  for (const dial of ordered) {
    if (dial.at >= recentStart) {
      let byCustomer = latest.get(dial.asn);
      if (!byCustomer) latest.set(dial.asn, (byCustomer = new Map<string, NodeDial>()));
      byCustomer.set(dial.customerId, dial);
      const list = recentDials.get(dial.asn) ?? [];
      list.push(dial);
      recentDials.set(dial.asn, list);
    } else if (dial.carried) {
      let set = baseline.get(dial.asn);
      if (!set) baseline.set(dial.asn, (set = new Set<string>()));
      set.add(dial.customerId);
    }
  }

  const networks: NetworkFinding[] = [];
  const customers = new Set<string>();
  let onset: number | null = null;
  const carriedProtocols = new Set<string>();
  const failedProtocols = new Set<string>();
  for (const [asn, byCustomer] of latest) {
    let failed = 0;
    for (const [customer, dial] of byCustomer) {
      customers.add(customer);
      if (!dial.carried) failed += 1;
    }
    const tried = byCustomer.size;
    const carried = tried - failed;
    const before = baseline.get(asn)?.size ?? 0;
    const failing =
      failed >= MIN_FAILED_PER_NETWORK && carried <= MAX_CARRIED_SHARE * tried && before >= MIN_BASELINE_PER_NETWORK;
    networks.push({ asn, org: orgOf(asn), tried, failed, baseline: before, failing });
    if (!failing) continue;
    for (const dial of byCustomer.values()) {
      if (!dial.carried) onset = onset === null ? dial.at : Math.min(onset, dial.at);
    }
    for (const dial of recentDials.get(asn) ?? []) {
      if (!dial.protocol) continue;
      (dial.carried ? carriedProtocols : failedProtocols).add(dial.protocol);
    }
  }
  for (const p of carriedProtocols) failedProtocols.delete(p);
  networks.sort((a, b) => Number(b.failing) - Number(a.failing) || b.failed - a.failed || b.tried - a.tried);

  const failingNets = networks.filter((n) => n.failing);
  const thin = customers.size < THIN_CUSTOMERS;
  let summary: string;
  if (failingNets.length) {
    summary =
      `App reports: failing on ${failingNets.length} network${failingNets.length === 1 ? "" : "s"} -- ` +
      failingNets
        .map((n) => `${netLabel(n)}: ${n.failed} of ${n.tried} customers got nothing through, after it worked for ${n.baseline} there in the past week`)
        .join("; ");
  } else if (thin) {
    summary = `App reports: too few to judge (${customers.size} customer${customers.size === 1 ? "" : "s"} in the last ${RECENT_MS / HOUR} h)`;
  } else {
    summary = `App reports: ${customers.size} customers on ${networks.length} network${networks.length === 1 ? "" : "s"} in the last ${RECENT_MS / HOUR} h, none failing`;
  }

  return {
    family: "client",
    firing: failingNets.length > 0,
    thin,
    onset,
    summary,
    networks,
    carriedProtocols: [...carriedProtocols].sort(),
    failedProtocols: [...failedProtocols].sort(),
  };
}

/** How many people sent data through the server: now, and at this time of
 * day on each of the days before (index 0 = yesterday). Null for a day
 * that is not comparable (before the floor). */
export interface TrafficCounts {
  current: number;
  baseline: (number | null)[];
}

/** A cliff in the number of people sending data. Counted by upstream
 * bytes, so a block that lets a handshake through and drops the upload
 * still shows. Node-wide: the agent does not yet say which network a
 * user is on. */
export function trafficFamily(counts: TrafficCounts | undefined): FamilyResult {
  const days = (counts?.baseline ?? []).filter((d): d is number => typeof d === "number");
  const usual = days.length ? medianOf(days) : 0;
  const current = counts?.current ?? 0;
  const window = `${TRAFFIC_WINDOW_MS / HOUR} h`;
  if (days.length < MIN_BASELINE_DAYS || usual < TRAFFIC_MIN_BASELINE) {
    return {
      family: "traffic",
      firing: false,
      thin: true,
      onset: null,
      summary: `Traffic: too little history to judge (${current} sending in the last ${window}, usually ${usual} on ${days.length} comparable day${days.length === 1 ? "" : "s"})`,
      networks: [],
    };
  }
  const firing = current <= TRAFFIC_CLIFF_SHARE * usual;
  return {
    family: "traffic",
    firing,
    thin: false,
    onset: null,
    summary: `Traffic: ${current} people sent data in the last ${window}; usually ${usual} at this time of day${firing ? " -- a cliff" : ""}`,
    networks: [],
  };
}

export interface ProbeCheck {
  verdict: "REACHABLE" | "DEGRADED" | "UNREACHABLE" | "INCONCLUSIVE";
  checkedAt: number;
  /** Per-vantage detail as stored: [{ asn: "AS123", ok, ... }]. */
  detail: unknown;
}

/** The reachability monitor's probes: unreachable from every answering
 * vantage, several conclusive checks in a row. Checks the probe service
 * could not answer are skipped, never counted either way. `checks` newest
 * first. */
export function probeFamily(checks: ProbeCheck[], now: number, floor: number): FamilyResult {
  const conclusive = checks.filter((c) => c.checkedAt >= floor && c.checkedAt <= now && c.verdict !== "INCONCLUSIVE");
  const latest = conclusive[0];
  if (!latest || now - latest.checkedAt > PROBE_FRESH_MS) {
    return {
      family: "probe",
      firing: false,
      thin: true,
      onset: null,
      summary: `Probe: no conclusive check in the last ${PROBE_FRESH_MS / HOUR} h`,
      networks: [],
      tcpOpen: null,
    };
  }
  let streak = 0;
  let onset: number | null = null;
  for (const check of conclusive) {
    if (check.verdict !== "UNREACHABLE") break;
    streak += 1;
    onset = check.checkedAt;
  }
  const networks = vantageNetworks(latest.detail);
  const answered = networks.reduce((sum, n) => sum + n.tried, 0);
  const firing = streak >= PROBE_STREAK;
  const summary = firing
    ? `Probe: no connection from any of ${answered || "the"} answering vantages inside the country, ${streak} checks in a row`
    : latest.verdict === "UNREACHABLE"
      ? `Probe: no connection in the latest check (${streak} in a row so far)`
      : `Probe: ${latest.verdict === "DEGRADED" ? "partly reachable" : "reachable"} in the latest check`;
  return {
    family: "probe",
    firing,
    thin: false,
    onset: firing ? onset : null,
    summary,
    networks,
    tcpOpen: latest.verdict !== "UNREACHABLE",
  };
}

/** The networks a probe's vantages sit in, as tried/failed counts. */
export function vantageNetworks(detail: unknown): NetworkFinding[] {
  if (!Array.isArray(detail)) return [];
  const byAsn = new Map<number, NetworkFinding>();
  for (const row of detail as Array<Record<string, unknown>>) {
    if (!row || typeof row !== "object") continue;
    const asn = parseAsn(row.asn);
    const finding = byAsn.get(asn) ?? { asn, org: null, tried: 0, failed: 0, baseline: null, failing: false };
    finding.tried += 1;
    if (row.ok !== true) finding.failed += 1;
    finding.failing = finding.failed === finding.tried;
    byAsn.set(asn, finding);
  }
  return [...byAsn.values()].sort((a, b) => b.failed - a.failed || a.asn - b.asn);
}

function parseAsn(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string") return 0;
  const match = /^(?:AS)?(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : 0;
}

export interface Assessment {
  verdict: Verdict | null;
  /** Why it reached LIKELY_BLOCKED, in words. */
  reason: string | null;
  /** Since when each firing family has fired (ms). */
  since: Partial<Record<Family, number>>;
  /** Neither residential family has enough data to judge. */
  thinResidential: boolean;
  blockType: BlockType | null;
  /** Set when the server is down rather than blocked; verdict is then null. */
  outage: string | null;
}

/** Turns the three families into a verdict.
 *
 * LIKELY_BLOCKED when two families fire at once; or when the app reports
 * fail on several networks and have for a while; or when the probe alone
 * has fired for a long time and there is too little residential data to
 * contradict it (said so in the reason). Anything less is SUSPECT. */
export function assess(input: {
  client: FamilyResult;
  traffic: FamilyResult;
  probe: FamilyResult;
  outage: string | null;
  previousSince: Partial<Record<Family, number>>;
  now: number;
}): Assessment {
  const { client, traffic, probe, now } = input;
  const thinResidential = client.thin && traffic.thin;
  if (input.outage) {
    return { verdict: null, reason: null, since: {}, thinResidential, blockType: null, outage: input.outage };
  }

  const firing = [client, traffic, probe].filter((f) => f.firing);
  const since: Partial<Record<Family, number>> = {};
  for (const f of firing) {
    const previous = input.previousSince[f.family];
    since[f.family] = typeof previous === "number" ? previous : Math.min(f.onset ?? now, now);
  }
  if (firing.length === 0) {
    return { verdict: null, reason: null, since, thinResidential, blockType: null, outage: null };
  }

  const failingNetworks = client.networks.filter((n) => n.failing).length;
  let reason: string | null = null;
  if (firing.length >= 2) {
    reason = `${firing.length} independent signals agree (${firing.map((f) => f.family).join(", ")})`;
  } else if (client.firing && failingNetworks >= NETWORKS_FOR_LIKELY && now - since.client! >= CLIENT_SUSTAIN_MS) {
    reason = `app reports fail on ${failingNetworks} networks and have for over ${CLIENT_SUSTAIN_MS / HOUR} h`;
  } else if (probe.firing && thinResidential && now - since.probe! >= PROBE_ALONE_MS) {
    reason = `probes alone for over ${PROBE_ALONE_MS / HOUR} h; residential data too thin to judge`;
  }

  return {
    verdict: reason ? "LIKELY_BLOCKED" : "SUSPECT",
    reason,
    since,
    thinResidential,
    blockType: blockTypeOf(client, traffic, probe),
    outage: null,
  };
}

function blockTypeOf(client: FamilyResult, traffic: FamilyResult, probe: FamilyResult): BlockType | null {
  if (probe.firing) return "address";
  if (client.firing && client.carriedProtocols?.length && client.failedProtocols?.length) return "protocol";
  if ((client.firing || traffic.firing) && probe.tcpOpen === true) return "tunnel";
  return null;
}

export function netLabel(n: Pick<NetworkFinding, "asn" | "org">): string {
  if (!n.asn) return "an unnamed network";
  return n.org ? `AS${n.asn} (${n.org})` : `AS${n.asn}`;
}

export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
