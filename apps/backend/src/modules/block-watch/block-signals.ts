import { durationSeconds } from "../../common/duration";

/** Whether a server looks blocked from the watched country, from what the
 * backend already records. Pure functions; BlockWatchService loads the
 * data and acts on the answer.
 *
 * Three independent kinds of evidence ("families"):
 *
 * * client -- the apps' own connect reports: per network, whether the
 *   people who dialled this server lately got traffic through, and whether
 *   the server itself had carried traffic for those people before;
 * * traffic -- how many people sent data through the server lately,
 *   against the same time of day on earlier days;
 * * probe -- the third-party TCP probes from inside the country that the
 *   reachability monitor already runs.
 *
 * One family on its own is a suspicion. A page needs two that agree, or
 * one that is broad and has lasted. A server that is down is an outage,
 * not a block, and is never reported as one. An incident ends only on
 * evidence that the server works again, never because evidence ran out.
 *
 * The thresholds are settings (BLOCK_WATCH_TUNING), so the values in use
 * are not the ones written here. */

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
export const DAY = 24 * HOUR;

/** Every threshold the verdicts use. Durations in milliseconds. */
export interface BlockTuning {
  /** How far back "lately" reaches, for app reports. */
  recentWindow: number;
  /** How far back "before" reaches, for app reports and traffic. */
  baselineWindow: number;
  /** The slice of the day traffic is counted over. */
  trafficWindow: number;
  /** A probe check older than this says nothing. */
  probeFresh: number;
  minFailedPerNetwork: number;
  minBaselinePerNetwork: number;
  /** A network is failing while at most this share of its people get through. */
  maxCarriedShare: number;
  /** Fewer people than this in the reports is too little to judge. */
  thinCustomers: number;
  /** Upstream bytes in the window that count as using the server. */
  upstreamActiveBytes: number;
  minBaselineDays: number;
  trafficMinBaseline: number;
  /** Traffic at or below this share of usual is a cliff. */
  trafficCliffShare: number;
  /** Traffic at or above this share of usual shows the server working. */
  trafficRecoveryShare: number;
  /** A network that failed carries again with at least this many people,
   * and this share of them, getting through. */
  minCarriedAgain: number;
  carriedAgainShare: number;
  probeStreak: number;
  networksForLikely: number;
  clientSustain: number;
  probeAlone: number;
  /** Evaluations in a row showing the server working before it clears. */
  quietCyclesToClear: number;
}

/** Fallbacks for a value BLOCK_WATCH_TUNING does not set. */
export const DEFAULT_TUNING: Readonly<BlockTuning> = Object.freeze({
  recentWindow: 3 * HOUR,
  baselineWindow: 7 * DAY,
  trafficWindow: 2 * HOUR,
  probeFresh: 3 * HOUR,
  minFailedPerNetwork: 3,
  minBaselinePerNetwork: 2,
  maxCarriedShare: 0.25,
  thinCustomers: 3,
  upstreamActiveBytes: 20 * 1024,
  minBaselineDays: 3,
  trafficMinBaseline: 5,
  trafficCliffShare: 0.3,
  trafficRecoveryShare: 0.7,
  minCarriedAgain: 2,
  carriedAgainShare: 0.5,
  probeStreak: 2,
  networksForLikely: 2,
  clientSustain: 1 * HOUR,
  probeAlone: 6 * HOUR,
  quietCyclesToClear: 2,
});

type TuningKind = "duration" | "count" | "share";
const TUNING_KINDS: Record<keyof BlockTuning, TuningKind> = {
  recentWindow: "duration",
  baselineWindow: "duration",
  trafficWindow: "duration",
  probeFresh: "duration",
  minFailedPerNetwork: "count",
  minBaselinePerNetwork: "count",
  maxCarriedShare: "share",
  thinCustomers: "count",
  upstreamActiveBytes: "count",
  minBaselineDays: "count",
  trafficMinBaseline: "count",
  trafficCliffShare: "share",
  trafficRecoveryShare: "share",
  minCarriedAgain: "count",
  carriedAgainShare: "share",
  probeStreak: "count",
  networksForLikely: "count",
  clientSustain: "duration",
  probeAlone: "duration",
  quietCyclesToClear: "count",
};

/** BLOCK_WATCH_TUNING: `name=value` pairs separated by commas or spaces,
 * e.g. `recentWindow=2h, maxCarriedShare=0.2`. Durations as "90m", "3h",
 * "7d"; shares above 0 and at most 1; counts whole and at least 1. A
 * value that does not read, or a name that is not one, keeps its
 * fallback and is reported in `problems` -- never in a way that stops the
 * watch. Blank is all fallbacks. */
export function parseTuning(raw: string | null | undefined): { tuning: BlockTuning; problems: string[] } {
  const tuning: BlockTuning = { ...DEFAULT_TUNING };
  const problems: string[] = [];
  for (const pair of (raw ?? "").split(/[\s,;]+/).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const name = (eq < 0 ? pair : pair.slice(0, eq)).trim() as keyof BlockTuning;
    const value = eq < 0 ? "" : pair.slice(eq + 1).trim();
    const kind = Object.prototype.hasOwnProperty.call(TUNING_KINDS, name) ? TUNING_KINDS[name] : undefined;
    if (!kind) {
      problems.push(`unknown setting "${name}"`);
      continue;
    }
    let parsed = Number.NaN;
    if (kind === "duration") {
      const seconds = durationSeconds(value, -1);
      if (seconds > 0) parsed = seconds * 1000;
    } else if (kind === "count") {
      if (/^\d+$/.test(value) && Number(value) >= 1) parsed = Number(value);
    } else if (/^(0?\.\d+|1(\.0+)?)$/.test(value) && Number(value) > 0) {
      parsed = Number(value);
    }
    if (Number.isNaN(parsed)) {
      problems.push(`${name}=${value} is not a valid ${kind}`);
      continue;
    }
    tuning[name] = parsed;
  }
  // Windows that only make sense in this order.
  if (tuning.trafficWindow >= DAY) {
    problems.push("trafficWindow must be under a day");
    tuning.trafficWindow = DEFAULT_TUNING.trafficWindow;
  }
  if (tuning.baselineWindow < DAY || tuning.baselineWindow <= tuning.recentWindow) {
    problems.push("baselineWindow must be at least a day and longer than recentWindow");
    tuning.baselineWindow = Math.max(DEFAULT_TUNING.baselineWindow, tuning.recentWindow + DAY);
  }
  if (tuning.trafficRecoveryShare <= tuning.trafficCliffShare) {
    problems.push("trafficRecoveryShare must be above trafficCliffShare");
    tuning.trafficCliffShare = DEFAULT_TUNING.trafficCliffShare;
    tuning.trafficRecoveryShare = Math.max(DEFAULT_TUNING.trafficRecoveryShare, tuning.trafficCliffShare + 0.1);
  }
  return { tuning, problems };
}

/** Whole days of traffic history compared against. */
export function baselineDays(tuning: BlockTuning): number {
  return Math.max(1, Math.floor(tuning.baselineWindow / DAY));
}

export interface NetworkFinding {
  /** 0 when the probe service did not say. */
  asn: number;
  org: string | null;
  /** Customers (client) or vantages (probe) heard from. */
  tried: number;
  failed: number;
  /** Of those customers, how many the server had carried traffic for
   * before (client only). */
  baseline: number | null;
  failing: boolean;
}

export interface FamilyResult {
  family: Family;
  firing: boolean;
  /** Too little data to say anything either way. */
  thin: boolean;
  /** Positive evidence the server works for what this family measures:
   * the probes connect, traffic is back near usual, or networks that had
   * failed carry again. What an open incident needs before it clears. */
  healthy: boolean;
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

/** A customer's latest dial of one direct route into this server. */
export interface NodeDial {
  customerId: string;
  asn: number;
  carried: boolean;
  /** When it happened (ms), as the client says, never later than its
   * arrival: orders one customer's dials. */
  at: number;
  /** When the report arrived (ms). Windows and onsets go by this, which a
   * client cannot move. */
  arrived: number;
  protocol: string | null;
  /** The rung's place in its report's ladder; a later rung was dialled
   * later. */
  rung?: number;
}

/** The apps' reports, per network. A network counts as failing when
 * several distinct customers on it dialled lately and nearly all got
 * nothing through, and the server had carried traffic for enough of those
 * same people before -- measured by the server, not claimed by an app. A
 * network it never worked on is not a new block. Counted by each
 * customer's latest dial, so retries count once.
 *
 * `failedAsns`, for an open incident: the networks that failed during
 * it. The family is healthy when one of them carries again. */
export function clientFamily(
  dials: NodeDial[],
  now: number,
  floor: number,
  carriedBefore: ReadonlySet<string>,
  tuning: BlockTuning = DEFAULT_TUNING,
  opts: { failedAsns?: readonly number[]; orgOf?: (asn: number) => string | null } = {},
): FamilyResult {
  const orgOf = opts.orgOf ?? (() => null);
  const recentStart = Math.max(now - tuning.recentWindow, floor);
  const recent = dials
    .filter((d) => d.arrived >= recentStart && d.arrived <= now && d.at >= recentStart)
    .sort((a, b) => a.at - b.at || a.arrived - b.arrived || (a.rung ?? 0) - (b.rung ?? 0));

  const latest = new Map<number, Map<string, NodeDial>>();
  const recentDials = new Map<number, NodeDial[]>();
  for (const dial of recent) {
    let byCustomer = latest.get(dial.asn);
    if (!byCustomer) latest.set(dial.asn, (byCustomer = new Map<string, NodeDial>()));
    byCustomer.set(dial.customerId, dial);
    const list = recentDials.get(dial.asn) ?? [];
    list.push(dial);
    recentDials.set(dial.asn, list);
  }

  const networks: NetworkFinding[] = [];
  const customers = new Set<string>();
  let onset: number | null = null;
  const carriedProtocols = new Set<string>();
  const failedProtocols = new Set<string>();
  for (const [asn, byCustomer] of latest) {
    let failed = 0;
    let before = 0;
    for (const [customer, dial] of byCustomer) {
      customers.add(customer);
      if (!dial.carried) failed += 1;
      if (carriedBefore.has(customer)) before += 1;
    }
    const tried = byCustomer.size;
    const carried = tried - failed;
    const failing =
      failed >= tuning.minFailedPerNetwork &&
      carried <= tuning.maxCarriedShare * tried &&
      before >= tuning.minBaselinePerNetwork;
    networks.push({ asn, org: orgOf(asn), tried, failed, baseline: before, failing });
    if (!failing) continue;
    for (const dial of byCustomer.values()) {
      if (!dial.carried) onset = onset === null ? dial.arrived : Math.min(onset, dial.arrived);
    }
    for (const dial of recentDials.get(asn) ?? []) {
      if (!dial.protocol) continue;
      (dial.carried ? carriedProtocols : failedProtocols).add(dial.protocol);
    }
  }
  for (const p of carriedProtocols) failedProtocols.delete(p);
  networks.sort((a, b) => Number(b.failing) - Number(a.failing) || b.failed - a.failed || b.tried - a.tried);

  const failingNets = networks.filter((n) => n.failing);
  const watched = new Set(opts.failedAsns ?? []);
  const carryingAgain = networks.filter((n) => {
    const carried = n.tried - n.failed;
    return watched.has(n.asn) && carried >= tuning.minCarriedAgain && carried >= tuning.carriedAgainShare * n.tried;
  });
  const thin = customers.size < tuning.thinCustomers;
  const hours = Math.round(tuning.recentWindow / HOUR);
  let summary: string;
  if (failingNets.length) {
    summary =
      `App reports: failing on ${failingNets.length} network${failingNets.length === 1 ? "" : "s"} -- ` +
      failingNets
        .map(
          (n) =>
            `${netLabel(n)}: ${n.failed} of ${n.tried} customers got nothing through; the server had carried traffic for ${n.baseline} of them before`,
        )
        .join("; ");
  } else if (carryingAgain.length) {
    summary =
      "App reports: carrying again where it had failed -- " +
      carryingAgain.map((n) => `${netLabel(n)}: ${n.tried - n.failed} of ${n.tried} customers got through`).join("; ");
  } else if (thin) {
    summary = `App reports: too few to judge (${customers.size} customer${customers.size === 1 ? "" : "s"} in the last ${hours} h)`;
  } else {
    summary = `App reports: ${customers.size} customers on ${networks.length} network${networks.length === 1 ? "" : "s"} in the last ${hours} h, none failing`;
  }

  return {
    family: "client",
    firing: failingNets.length > 0,
    thin,
    healthy: failingNets.length === 0 && carryingAgain.length > 0,
    onset,
    summary,
    networks,
    carriedProtocols: [...carriedProtocols].sort(),
    failedProtocols: [...failedProtocols].sort(),
  };
}

/** How many people sent data through the server: now, and at this time of
 * day on each of the earlier days compared against. Null for a day that
 * is not comparable (before the floor). `beforeIncident` when those days
 * are the ones before an open incident began. */
export interface TrafficCounts {
  current: number;
  baseline: (number | null)[];
  beforeIncident?: boolean;
}

/** A cliff in the number of people sending data. Counted by upstream
 * bytes, so a block that lets a handshake through and drops the upload
 * still shows. Node-wide: the agent does not yet say which network a user
 * is on. While an incident is open the comparison is with the days before
 * it began, so a block that lasts never becomes the usual. */
export function trafficFamily(counts: TrafficCounts | undefined, tuning: BlockTuning = DEFAULT_TUNING): FamilyResult {
  const days = (counts?.baseline ?? []).filter((d): d is number => typeof d === "number");
  const usual = days.length ? medianOf(days) : 0;
  const current = counts?.current ?? 0;
  const window = `${Math.round(tuning.trafficWindow / HOUR)} h`;
  if (days.length < tuning.minBaselineDays || usual < tuning.trafficMinBaseline) {
    return {
      family: "traffic",
      firing: false,
      thin: true,
      healthy: false,
      onset: null,
      summary: `Traffic: too little history to judge (${current} sending in the last ${window}, usually ${usual} on ${days.length} comparable day${days.length === 1 ? "" : "s"})`,
      networks: [],
    };
  }
  const firing = current <= tuning.trafficCliffShare * usual;
  const healthy = current >= tuning.trafficRecoveryShare * usual;
  return {
    family: "traffic",
    firing,
    thin: false,
    healthy,
    onset: null,
    summary:
      `Traffic: ${current} people sent data in the last ${window}; usually ${usual} at this time of day` +
      `${counts?.beforeIncident ? " before this began" : ""}${firing ? " -- a cliff" : ""}`,
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
export function probeFamily(
  checks: ProbeCheck[],
  now: number,
  floor: number,
  tuning: BlockTuning = DEFAULT_TUNING,
): FamilyResult {
  const conclusive = checks.filter((c) => c.checkedAt >= floor && c.checkedAt <= now && c.verdict !== "INCONCLUSIVE");
  const latest = conclusive[0];
  if (!latest || now - latest.checkedAt > tuning.probeFresh) {
    return {
      family: "probe",
      firing: false,
      thin: true,
      healthy: false,
      onset: null,
      summary: `Probe: no conclusive check in the last ${Math.round(tuning.probeFresh / HOUR)} h`,
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
  const firing = streak >= tuning.probeStreak;
  const summary = firing
    ? `Probe: no connection from any of ${answered || "the"} answering vantages inside the country, ${streak} checks in a row`
    : latest.verdict === "UNREACHABLE"
      ? `Probe: no connection in the latest check (${streak} in a row so far)`
      : `Probe: ${latest.verdict === "DEGRADED" ? "partly reachable" : "reachable"} in the latest check`;
  return {
    family: "probe",
    firing,
    thin: false,
    healthy: latest.verdict === "REACHABLE",
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
 * fail on several networks and have for a while, and the server's own
 * traffic does not show it working as usual; or when the probe alone has
 * fired for a long time and there is too little residential data to
 * contradict it (said so in the reason). Anything less is SUSPECT. */
export function assess(input: {
  client: FamilyResult;
  traffic: FamilyResult;
  probe: FamilyResult;
  outage: string | null;
  previousSince: Partial<Record<Family, number>>;
  now: number;
  tuning?: BlockTuning;
}): Assessment {
  const { client, traffic, probe, now } = input;
  const tuning = input.tuning ?? DEFAULT_TUNING;
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
  } else if (
    client.firing &&
    failingNetworks >= tuning.networksForLikely &&
    now - since.client! >= tuning.clientSustain &&
    // App reports alone, against a server whose own traffic is as usual,
    // are not enough: reports can be made up, the server's count cannot.
    !traffic.healthy
  ) {
    reason = `app reports fail on ${failingNetworks} networks and have for a while, and the server's traffic is not as usual`;
  } else if (probe.firing && thinResidential && now - since.probe! >= tuning.probeAlone) {
    reason = "probes alone, for hours; residential data too thin to judge";
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

/** Which of the families that fired during an open incident now show the
 * server working. An incident clears only on these; a family that went
 * quiet for want of data proves nothing. */
export function recoveredFamilies(fired: readonly Family[], results: readonly FamilyResult[]): Family[] {
  return results.filter((r) => fired.includes(r.family) && r.healthy).map((r) => r.family);
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
