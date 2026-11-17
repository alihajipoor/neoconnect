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
 *   reachability monitor already runs;
 * * inside -- our own boxes inside the country (modules/inside-probe):
 *   whether each still opens a TCP connection to the server, and, for a
 *   box that normally moves data to it, whether data still moves, judged
 *   only in rounds where the same box reached other servers;
 * * bytes -- the server's own upstream bytes over a day against its usual
 *   day. Corroboration only: it never fires unless the inside family has.
 *
 * One family on its own is a suspicion. A page needs two that agree, or
 * one that is broad and has lasted. A server that is down is an outage,
 * not a block, and is never reported as one. An incident ends only on
 * evidence that the server works again, never because evidence ran out.
 *
 * The thresholds are settings (BLOCK_WATCH_TUNING), so the values in use
 * are not the ones written here. */

export type Family = "client" | "traffic" | "probe" | "inside" | "bytes";
export const FAMILIES: readonly Family[] = ["client", "traffic", "probe", "inside", "bytes"];

/** Each family in plain words, for a reason a person reads. */
export const FAMILY_LABELS: Record<Family, string> = {
  client: "the apps' connect reports",
  traffic: "the server's own traffic",
  probe: "the outside TCP check from inside the country",
  inside: "our own boxes inside the country",
  bytes: "the server's own byte count",
};

/** Rounds in a row (the inside probe runs every 30 minutes) in which a box
 * that normally connects to a server gets no TCP connection to it, while
 * it still reaches other servers, before that box's evidence counts. Four
 * rounds span 1.5 hours from the first lost one, so with the block watch's
 * own 30-minute cadence an address-level block is told in 1.5 to 2 hours
 * of the first lost round -- against the 22 hours a blocked server waited on
 * 2026-11-12. Fewer would page on a routing blip of an hour; the boxes'
 * connects to healthy servers fail far less often than that. */
export const INSIDE_LOST_ROUNDS = 4;
/** A box "normally reaches" a server when it connected in at least this
 * share of at least this many earlier rounds in which it was alive. A
 * server a box has never reached (one of its networks never could) says
 * nothing about a new block from that box. */
export const INSIDE_BASELINE_ROUNDS = 6;
export const INSIDE_BASELINE_SHARE = 0.5;
/** An inside box with no row for this long has stopped reporting. One
 * figure for the silent-box message and for each server's own evidence,
 * so the two never disagree about which boxes are speaking. */
export const INSIDE_SILENT_AFTER_MS = 2 * 3_600_000;
/** The server's own bytes count beside an inside loss only within this of
 * the loss beginning (or while they have counted without a break since).
 * A loss from one box that lasts for days (netherlands-1 from 2026-11-14,
 * one network's change while customers kept using it) must not turn into
 * a block page on the first quiet afternoon of a lumpy server. */
export const BYTES_BESIDE_INSIDE_MS = 48 * 3_600_000;
/** A data-only loss from a single box, while the server's own traffic has
 * not collapsed, is read as that box's network changing once it has gone
 * on this long: by then a block of the server would show in its bytes. */
export const ONE_NETWORK_AFTER_MS = 24 * 3_600_000;

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
  /** Inside-probe rounds in a row without a connection, or, from a box
   * that normally moves data, without data (INSIDE_LOST_ROUNDS). */
  insideRounds: number;
  /** Evaluations in a row showing the server working before it clears. */
  quietCyclesToClear: number;
  /** The server's upstream bytes over the last day at or below this share
   * of its usual day count as collapsed (the bytes family). */
  bytesCliffShare: number;
  /** A usual day under this many upstream bytes is too little to judge:
   * on a lightly used server a quiet day looks like a collapse. */
  bytesMinUsual: number;
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
  insideRounds: INSIDE_LOST_ROUNDS,
  quietCyclesToClear: 2,
  bytesCliffShare: 0.3,
  bytesMinUsual: 20 * 1024 * 1024,
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
  insideRounds: "count",
  quietCyclesToClear: "count",
  bytesCliffShare: "share",
  bytesMinUsual: "count",
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
  /** Not read this evaluation (the data it needs was not available, e.g.
   * the network table had not loaded). Neither thin nor evidence: it
   * keeps the "too little data" rules from firing on its absence. */
  unknown?: boolean;
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
  /** inside, while it fires: which boxes lost the server, and what the
   * others show. Stored with the incident, so a message can say it. */
  scope?: InsideScope;
  /** inside, while it fires: whether a box lost the TCP connection
   * itself (an address-level loss), rather than only the data. */
  lostTcp?: boolean;
  /** bytes: the server's own totals over the last day and its usual day. */
  bytes?: ByteReading;
}

/** How far an inside loss reaches across our boxes.
 * partial: another reporting box still moves data to the server;
 * some: another reporting box neither lost it nor shows it working (it
 *   never moves data there, so it can say nothing either way);
 * all: every box that is reporting lost it;
 * only: only one box is reporting, and it lost it. */
export interface InsideScope {
  kind: "partial" | "some" | "all" | "only";
  /** Another reporting box shows the server working: said as partial. */
  partial: boolean;
  lost: string[];
  working: string[];
  reporting: string[];
  /** Boxes with no recent round at all, and their last one (ISO). */
  silent: { vantage: string; lastAt: string }[];
  /** In words, e.g. "from 1 of 2 inside networks (signin); still moves
   * data from ir2". */
  text: string;
}

export interface ByteReading {
  up: number;
  down: number;
  /** Medians of the comparable earlier days; null without enough of them. */
  usualUp: number | null;
  usualDown: number | null;
  days: number;
  /** At or below the cliff share of usual, whether or not it may fire. */
  collapsed: boolean;
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

/** The server's own bytes over the last day, and over each of the earlier
 * days compared against (null where not comparable: before the owner's
 * last answer). `beforeIncident` as for TrafficCounts. */
export interface ByteTotals {
  current: { up: number; down: number };
  baseline: ({ up: number; down: number } | null)[];
  beforeIncident?: boolean;
}

/** The server's own upstream bytes collapsing: the last day's upload at or
 * below `bytesCliffShare` of the median earlier day. Unlike the traffic
 * family it does not count people, so it reads a server with a handful
 * of heavy users (uk-1 fell from 55 GB to 15 MB a day down on 2026-11-15
 * while the people count stayed too small to judge).
 *
 * Corroboration only, never evidence alone: on a lightly used server a
 * quiet day looks just like a collapse (several such days in October and
 * November on servers that were fine). So it fires only when the inside
 * family has fired (`insideFiring`), and then is the second signal that
 * makes an inside loss likely. Healthy when the upload is back near usual. */
export function bytesFamily(
  totals: ByteTotals | undefined,
  insideFiring: boolean,
  tuning: BlockTuning = DEFAULT_TUNING,
): FamilyResult {
  const days = (totals?.baseline ?? []).filter((d): d is { up: number; down: number } => d !== null);
  const up = totals?.current.up ?? 0;
  const down = totals?.current.down ?? 0;
  const usualUp = days.length ? medianOf(days.map((d) => d.up)) : null;
  const usualDown = days.length ? medianOf(days.map((d) => d.down)) : null;
  const thin = days.length < tuning.minBaselineDays || (usualUp ?? 0) < tuning.bytesMinUsual;
  const collapsed = !thin && up <= tuning.bytesCliffShare * (usualUp ?? 0);
  const reading: ByteReading = { up, down, usualUp, usualDown, days: days.length, collapsed };
  const usual =
    usualUp === null
      ? "no earlier day to compare"
      : `usually ${formatBytes(usualUp)} up and ${formatBytes(usualDown ?? 0)} down a day${totals?.beforeIncident ? " before this began" : ""}`;
  const now = `${formatBytes(up)} up and ${formatBytes(down)} down in the last 24 h`;
  const summary = thin
    ? `Server's own bytes: too little history to judge (${now}; ${usual})`
    : `Server's own bytes: ${now}; ${usual}` +
      (collapsed ? (insideFiring ? " -- collapsed" : " -- low, but counted only beside a recent loss from our inside boxes") : "");
  return {
    family: "bytes",
    firing: collapsed && insideFiring,
    thin,
    healthy: !thin && up >= tuning.trafficRecoveryShare * (usualUp ?? 0),
    onset: null,
    summary,
    networks: [],
    bytes: reading,
  };
}

/** Bytes for a person: "9 MB", "1.5 GB". */
export function formatBytes(n: number): string {
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  return n > 0 ? "under 0.1 MB" : "0 MB";
}

export interface ProbeCheck {
  verdict: "REACHABLE" | "DEGRADED" | "UNREACHABLE" | "INCONCLUSIVE";
  checkedAt: number;
  /** Per-vantage detail as stored: [{ asn: "AS123", ok, ... }]. */
  detail: unknown;
}

/** The reachability monitor's probes: unreachable -- most answering
 * vantages could not connect -- several conclusive checks in a row. Checks the probe service
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
    ? `Probe: most of ${answered || "the"} answering vantages inside the country could not connect, ${streak} checks in a row`
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

/** The client family when its data could not be read this evaluation:
 * the network table that says which networks are in the country had not
 * loaded. Unknown -- never "too few customers", which would let the
 * probe-alone rule page on a backend restart (2026-11-13). */
export function unknownClientFamily(why: string): FamilyResult {
  return {
    family: "client",
    firing: false,
    thin: false,
    unknown: true,
    healthy: false,
    onset: null,
    summary: `App reports: not read this time -- ${why}`,
    networks: [],
  };
}

/** One server's result in one inside-probe round from one box. */
export interface InsideCheck {
  nodeId: string;
  /** The box ("ir2", "signin"): each is its own series. */
  vantage: string;
  /** Whether a TCP connection opened (the probe's connectMs). Losing it is
   * the evidence of a block. */
  connected: boolean;
  /** Whether any data then moved (down or up bytes above zero). From a box
   * that never moves data to the server it means nothing -- one box
   * connects and moves nothing to several healthy servers as its normal
   * state, and did so through the blocks of 2026-10-28 and 2026-11-07. From
   * a box that normally moves data to it (a mover), a round that connects
   * and moves nothing either way is a lost round: uk-1 kept accepting the
   * connection from 2026-11-14 20:08 while nothing moved, for three days. */
  moved: boolean;
  /** The round's time; every row of one round carries the same one (ms). */
  checkedAt: number;
}

/** A box's round counts only when it connected to at least this share of
 * the other servers it usually connects to in a round (its median), and
 * to at least one. A box whose own network is partly failing, reaching one
 * server where it usually reaches eight, says nothing about the other
 * seven: counted, it would fire for each of them at once. */
export const INSIDE_ALIVE_SHARE = 0.5;

interface BoxReading {
  vantage: string;
  /** Normally connects to this server. */
  qualified: boolean;
  /** Normally moves data to this server. */
  mover: boolean;
  /** Latest alive rounds in a row lost: no connection to it, or, for a
   * mover, a connection that moved nothing in a round where the box still
   * moved data to other servers it usually moves data to. */
  streak: number;
  /** Of those, rounds with no connection at all. */
  tcpLost: number;
  /** Connected in its latest alive round. */
  connectedNow: boolean;
  /** Data moved in its latest alive round. */
  movedNow: boolean;
  /** The first round of the streak (ms). */
  streakStart: number | null;
}

/** Our own boxes inside the country, read for one server.
 *
 * A round counts for a box only when that box connected to most of the
 * OTHER servers it usually reaches in a round (INSIDE_ALIVE_SHARE): a box
 * that reaches nothing, or far less than usual, is a box or network
 * problem, not a block, and its round is skipped, never counted either
 * way. Each box's own rounds are then read newest first: how many in a
 * row were lost (the streak), and, before that, whether it normally
 * connected at all and whether it normally moved data (INSIDE_BASELINE_*).
 * A box that never reached the server gives no evidence of a block.
 *
 * A round is lost when the box got no connection. For a mover it is also
 * lost when the box connected and moved nothing either way, provided that
 * in the same round it moved data to at least one other server it usually
 * moves data to: a box whose own line carries nothing proves nothing, and
 * such a round is skipped, neither lost nor working.
 *
 * Fires when at least one box that normally reaches the server has lost it
 * for `insideRounds` rounds in a row. Whether another box still shows it
 * working is the scope (InsideScope), not a veto: on 2026-11-14 one box
 * lost uk-1 while the other still moved data to it, and the veto kept the
 * watch silent for three days. A box shows the server working only by
 * moving data to it in its latest round; a bare connect is no proof, from
 * a mover or not. Healthy when no box that normally reaches it is losing
 * it, and a box shows it working: moving data, or, for a box that never
 * moves data to it, connecting. `checks` is every server's rows (the
 * other servers are how a box is known to be alive), from `floor` on. */
export function insideFamily(
  checks: InsideCheck[],
  nodeId: string,
  now: number,
  floor: number,
  tuning: BlockTuning = DEFAULT_TUNING,
  /** Boxes an open incident on this server recorded as having lost it. They
   * were movers when it began; once the rounds from before the loss age out
   * of the rows kept (30 days), that can no longer be read from the rows,
   * and their bare connects would otherwise read as the server working. */
  knownMovers: readonly string[] = [],
): FamilyResult {
  type Round = { self: boolean | null; moved: boolean; others: number; movedTo: string[] };
  const byBox = new Map<string, Map<number, Round>>();
  // Per box and other server: rounds with a row, and rounds that moved data.
  const moves = new Map<string, Map<string, { rows: number; moved: number }>>();
  const lastRow = new Map<string, number>();
  for (const c of checks) {
    if (c.checkedAt < floor || c.checkedAt > now) continue;
    lastRow.set(c.vantage, Math.max(lastRow.get(c.vantage) ?? 0, c.checkedAt));
    let rounds = byBox.get(c.vantage);
    if (!rounds) byBox.set(c.vantage, (rounds = new Map<number, Round>()));
    const round = rounds.get(c.checkedAt) ?? { self: null, moved: false, others: 0, movedTo: [] };
    if (c.nodeId === nodeId) {
      round.self = c.connected;
      round.moved = c.connected && c.moved;
    } else {
      if (c.connected) round.others += 1;
      if (c.connected && c.moved) round.movedTo.push(c.nodeId);
      let perNode = moves.get(c.vantage);
      if (!perNode) moves.set(c.vantage, (perNode = new Map<string, { rows: number; moved: number }>()));
      const m = perNode.get(c.nodeId) ?? { rows: 0, moved: 0 };
      m.rows += 1;
      if (c.connected && c.moved) m.moved += 1;
      perNode.set(c.nodeId, m);
    }
    rounds.set(c.checkedAt, round);
  }

  const boxes: BoxReading[] = [];
  const silent: { vantage: string; lastAt: string }[] = [];
  // Boxes that report but whose own line has carried no usable round lately.
  const dead: { vantage: string }[] = [];
  for (const [vantage, rounds] of [...byBox.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const usual = median([...rounds.values()].map((r) => r.others));
    const needed = Math.max(1, Math.ceil(INSIDE_ALIVE_SHARE * usual));
    const alive = [...rounds.entries()]
      .filter(([, r]) => r.others >= needed && r.self !== null)
      .sort(([a], [b]) => b - a);
    const last = lastRow.get(vantage) ?? 0;
    if (now - last > INSIDE_SILENT_AFTER_MS) {
      // Not a box whose network fails (that one still reports): one that
      // has stopped reporting at all. Said, never dropped without a word.
      silent.push({ vantage, lastAt: new Date(last).toISOString() });
      continue;
    }
    if (!alive.length || now - alive[0][0] > tuning.probeFresh) {
      // Still reporting, but reaching too little of anything to count: said
      // as unable to tell, so the scope never reads as one box reporting.
      const usable = [...rounds.entries()].some(([at, r]) => now - at <= tuning.probeFresh && r.others >= needed);
      if (!usable) dead.push({ vantage });
      continue;
    }
    // The other servers this box usually moves data to: a round that moved
    // data to none of them says the box's own line carried nothing.
    const usualMovers = new Set(
      [...(moves.get(vantage) ?? new Map<string, { rows: number; moved: number }>()).entries()]
        .filter(([, m]) => m.rows >= INSIDE_BASELINE_ROUNDS && m.moved >= INSIDE_BASELINE_SHARE * m.rows)
        .map(([id]) => id),
    );
    const dataAlive = (r: Round) => r.movedTo.some((id) => usualMovers.has(id));
    // Read once counting a mover's empty rounds as lost; if the rounds
    // before that streak show it is not a mover after all, read again
    // counting lost connections only.
    const read = (asMover: boolean) => {
      let streak = 0;
      let tcpLost = 0;
      let streakStart: number | null = null;
      let i = 0;
      for (; i < alive.length; i += 1) {
        const [at, r] = alive[i];
        if (!r.self) {
          tcpLost += 1;
        } else if (asMover && !r.moved) {
          if (!dataAlive(r)) continue;
        } else break;
        streak += 1;
        streakStart = at;
      }
      const before = alive.slice(i);
      const enough = before.length >= INSIDE_BASELINE_ROUNDS;
      return {
        streak,
        tcpLost,
        streakStart,
        enough,
        qualified: enough && before.filter(([, r]) => r.self).length >= INSIDE_BASELINE_SHARE * before.length,
        mover: enough && before.filter(([, r]) => r.moved).length >= INSIDE_BASELINE_SHARE * before.length,
      };
    };
    const asMover = read(true);
    // The open incident's record says this box was a mover; the rows before
    // its loss are gone, not contrary.
    const remembered = knownMovers.includes(vantage) && !asMover.enough && asMover.streak > 0;
    const reading = asMover.mover
      ? asMover
      : remembered
        ? { ...asMover, mover: true, qualified: true }
        : read(false);
    boxes.push({
      vantage,
      qualified: reading.qualified,
      mover: reading.mover,
      streak: reading.streak,
      tcpLost: reading.tcpLost,
      connectedNow: alive[0][1].self === true,
      movedNow: alive[0][1].moved,
      streakStart: reading.streakStart,
    });
  }

  const qualified = boxes.filter((b) => b.qualified);
  const lost = qualified.filter((b) => b.streak >= tuning.insideRounds);
  const working = boxes.filter((b) => b.connectedNow && b.movedNow);
  const firing = lost.length > 0;
  const healthy =
    !firing &&
    !qualified.some((b) => b.streak > 0) &&
    boxes.some((b) => b.connectedNow && (b.movedNow || !b.mover));
  const names = (list: { vantage: string }[]) => list.map((b) => b.vantage).join(" and ");
  const reportingCount = boxes.length + dead.length;
  const deadNote = dead.length
    ? `${names(dead)} report${dead.length === 1 ? "s" : ""}, but ${dead.length === 1 ? "its" : "their"} own line carries nothing, so cannot tell`
    : "";
  const silentNote = [
    ...(silent.length && reportingCount === 1 ? ["only one inside box is reporting"] : []),
    ...silent.map((s) => `${s.vantage} has not reported since ${s.lastAt}`),
    ...(deadNote ? [deadNote] : []),
  ].join("; ");
  let scope: InsideScope | undefined;
  let summary: string;
  if (firing) {
    const others = boxes.filter((b) => !lost.includes(b));
    const workingOthers = others.filter((b) => working.includes(b));
    const kind: InsideScope["kind"] =
      reportingCount === 1 ? "only" : !others.length && !dead.length ? "all" : workingOthers.length ? "partial" : "some";
    const of = `from ${lost.length} of ${reportingCount} inside networks (${names(lost)})`;
    const text =
      kind === "only"
        ? `from ${names(lost)}; only one inside box is reporting`
        : kind === "all"
          ? `from every inside box that is reporting (${names(lost)})`
          : kind === "partial"
            ? `${of}; still moves data from ${names(workingOthers)}`
            : others.length
              ? `${of}; ${names(others)} shows it neither working nor lost`
              : of;
    scope = {
      kind,
      partial: kind === "partial",
      lost: lost.map((b) => b.vantage),
      working: workingOthers.map((b) => b.vantage),
      reporting: [...boxes, ...dead].map((b) => b.vantage).sort(),
      silent,
      text:
        text +
        (deadNote ? `; ${deadNote}` : "") +
        (silent.length ? `; ${silent.map((s) => `${s.vantage} has not reported since ${s.lastAt}`).join("; ")}` : ""),
    };
    const rounds = Math.min(...lost.map((b) => b.streak));
    const one = lost.length === 1;
    const tcpOnly = lost.every((b) => b.tcpLost === b.streak);
    const dataOnly = lost.every((b) => b.tcpLost === 0);
    const what = tcpOnly
      ? `could not open a connection to this server for ${rounds} checks in a row`
      : dataOnly
        ? `${one ? "connects" : "connect"} to this server but moved no data either way for ${rounds} checks in a row`
        : `could not open a connection to this server, or connected and moved no data, for ${rounds} checks in a row`;
    const bare = others.filter((b) => b.connectedNow && !b.movedNow && !b.mover);
    summary =
      `Our boxes inside the country: ${names(lost)} ${what}, ` +
      `while in the same checks ${one ? "it" : "they"} still reached most of the other servers ${one ? "it usually reaches" : "they usually reach"}` +
      (dataOnly || !tcpOnly ? ` and moved data to others ${one ? "it usually moves data to" : "they usually move data to"}` : "") +
      (bare.length
        ? `; ${names(bare)} still connect${bare.length === 1 ? "s" : ""} but move${bare.length === 1 ? "s" : ""} no data to it, as usual, which is no proof it works`
        : "") +
      ` -- ${scope.text}`;
  } else if (!boxes.length) {
    summary = "Our boxes inside the country: no recent check in which a box reached any server";
  } else if (!qualified.length) {
    summary = "Our boxes inside the country: no box that normally reaches this server has checked it lately";
  } else if (qualified.some((b) => b.streak > 0)) {
    const losing = qualified.filter((b) => b.streak > 0);
    summary = `Our boxes inside the country: ${names(losing)} lost it in the latest check (${Math.max(...losing.map((b) => b.streak))} in a row so far)`;
  } else {
    const moving = qualified.filter((b) => b.movedNow);
    summary = moving.length
      ? `Our boxes inside the country: ${names(moving)} move${moving.length === 1 ? "s" : ""} data to this server`
      : `Our boxes inside the country: ${names(qualified)} connect${qualified.length === 1 ? "s" : ""} to this server`;
  }
  if (!firing && silentNote) summary += ` (${silentNote})`;
  const starts = lost.map((b) => b.streakStart).filter((t): t is number => t !== null);
  return {
    family: "inside",
    firing,
    thin: qualified.length === 0,
    healthy,
    onset: firing && starts.length ? Math.min(...starts) : null,
    summary,
    networks: [],
    tcpOpen: qualified.length ? qualified.some((b) => b.connectedNow) : null,
    ...(scope ? { scope, lostTcp: lost.some((b) => b.tcpLost > 0) } : {}),
  };
}

/** Whether the server's own bytes may count beside the inside family this
 * evaluation: only while it fires, and, unless every reporting box lost
 * the server, only near when the loss began (BYTES_BESIDE_INSIDE_MS) or
 * while the bytes have counted without a break since (`bytesSince`). A
 * collapse that comes days after one box lost a server is a quiet day on
 * a server customers are using, not the same event. */
export function bytesMayCount(
  inside: FamilyResult,
  insideSince: number,
  bytesSince: number | undefined,
  now: number,
): boolean {
  if (!inside.firing) return false;
  if (inside.scope?.kind === "all" || bytesSince !== undefined) return true;
  return now - insideSince <= BYTES_BESIDE_INSIDE_MS;
}

/** A data-only loss from one box that has lasted ONE_NETWORK_AFTER_MS
 * while the server's own traffic has not collapsed is that box's network
 * changing, not a block: it stops firing and reads as healthy, so its
 * incident can close and stops holding the server's reachability e-mails.
 * netherlands-1 lost data from the sign-in box on 2026-11-14 in the same
 * round as uk-1 and kept carrying hundreds of MB a day; uk-1's bytes
 * collapsed. Too few bytes to judge keeps the loss as it is. */
export function settleOneNetwork(inside: FamilyResult, bytes: FamilyResult, insideSince: number, now: number): FamilyResult {
  if (!inside.firing || inside.lostTcp !== false || inside.scope?.lost.length !== 1) return inside;
  if (bytes.thin || !bytes.bytes || bytes.bytes.collapsed || now - insideSince < ONE_NETWORK_AFTER_MS) return inside;
  const { scope, lostTcp, ...rest } = inside;
  void lostTcp;
  return {
    ...rest,
    firing: false,
    healthy: true,
    onset: null,
    summary:
      `Our boxes inside the country: ${scope.lost[0]} has moved no data to this server for over ` +
      `${Math.floor((now - insideSince) / 3_600_000)} h, while the server's own traffic did not collapse ` +
      `(${formatBytes(bytes.bytes.up)} up in the last 24 h, usually ${formatBytes(bytes.bytes.usualUp ?? 0)}) -- ` +
      "read as that one network's change, not a block",
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

/** Turns the families into a verdict.
 *
 * LIKELY_BLOCKED when two families fire at once (our own boxes losing the
 * server together with the outside TCP check is the address-level block
 * told within hours); or when the app reports
 * fail on several networks and have for a while, and the server's own
 * traffic does not show it working as usual; or when the probe alone has
 * fired for a long time and there is too little residential data to
 * contradict it (said so in the reason). Anything less is SUSPECT.
 *
 * The server's own bytes count only beside the inside family: with it,
 * they are the second signal; without it, they are not a signal at all. */
export function assess(input: {
  client: FamilyResult;
  traffic: FamilyResult;
  probe: FamilyResult;
  /** Our own boxes inside the country; absent where nothing reads them. */
  inside?: FamilyResult;
  /** The server's own bytes; counted only while inside fires. */
  bytes?: FamilyResult;
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

  const insideFiring = input.inside?.firing === true;
  const all = [
    client,
    traffic,
    probe,
    ...(input.inside ? [input.inside] : []),
    ...(input.bytes ? [input.bytes] : []),
  ];
  const firing = all.filter((f) => f.firing && (f.family !== "bytes" || insideFiring));
  const since: Partial<Record<Family, number>> = {};
  for (const f of firing) {
    const previous = input.previousSince[f.family];
    since[f.family] = typeof previous === "number" ? previous : Math.min(f.onset ?? now, now);
  }
  // A family that could not be read this time (the network table still
  // loading after a restart) is not a family that stopped: it keeps its
  // "since", so a restart does not start its sustain timer again.
  for (const f of all) {
    const previous = input.previousSince[f.family];
    if (f.unknown && typeof previous === "number") since[f.family] = previous;
  }
  if (firing.length === 0) {
    return { verdict: null, reason: null, since, thinResidential, blockType: null, outage: null };
  }

  const failingNetworks = client.networks.filter((n) => n.failing).length;
  let reason: string | null = null;
  if (firing.length >= 2) {
    const others = firing.filter((f) => f.family !== "bytes").map((f) => FAMILY_LABELS[f.family]);
    reason = firing.some((f) => f.family === "bytes")
      ? `${firing.length} independent signals agree: ${others.join(", ")}, and the server's own traffic has collapsed`
      : `${firing.length} independent signals agree: ${others.join(", ")}`;
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
    blockType: blockTypeOf(client, traffic, probe, input.inside),
    outage: null,
  };
}

/** Which of the families that fired during an open incident now show the
 * server working. An incident clears only on these; a family that went
 * quiet for want of data proves nothing. */
export function recoveredFamilies(fired: readonly Family[], results: readonly FamilyResult[]): Family[] {
  return results.filter((r) => fired.includes(r.family) && r.healthy).map((r) => r.family);
}

function blockTypeOf(
  client: FamilyResult,
  traffic: FamilyResult,
  probe: FamilyResult,
  inside?: FamilyResult,
): BlockType | null {
  // Our boxes losing only the data (the connection still opens) is a
  // tunnel block, not an address one.
  if (probe.firing || (inside?.firing && inside.lostTcp !== false)) return "address";
  if (inside?.firing) return "tunnel";
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
