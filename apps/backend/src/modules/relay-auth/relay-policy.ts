import type { Prisma } from "@prisma/client";

/** The numbers behind relay sign-up (docs/relay-last-resort.md, R2.5 and
 * R3.5), and the pure functions that apply them. No I/O here, so every
 * rule has a test that does not need a database. */

export type RelayTier = "normal" | "intranet";

/** Proof of work over the relay: never below this, and two bits more for
 * each sign of pressure. Each bit doubles the cost. */
export const POW_FLOOR_BITS = 18;
export const POW_STEP_BITS = 2;
/** A caller past this many sign-ups in the last hour pays a step. */
export const POW_IP_HOURLY = 3;
/** Everyone pays a step while sign-ups in the last hour are past this. */
export const POW_GLOBAL_HOURLY = 50;
/** An install id past this many sign-ups today pays a step. Advisory: the
 * id is the client's say-so, so it only ever makes things dearer. */
export const POW_INSTALL_DAILY = 3;

/** Hard caps, per UTC day. */
export const IP_DAILY_CAP = 30;
export const GLOBAL_DAILY_CAP: Record<RelayTier, number> = { normal: 200, intranet: 3_000 };
/** One network may take at most this share of the day's cap... */
export const ASN_SHARE = 0.25;
/** ...and all the listed hosting networks together this one (F4: a few
 * Iranian VPSes must not be able to use up the day for everyone). */
export const HOSTING_SHARE = 0.05;

/** Customers our own mail may go to: everyone but a relay account whose
 * address is unconfirmed, which gets only the codes it asks for (R3.4,
 * F11). An unverified account an operator made is mailed as before. */
export const MAILABLE_CUSTOMER: Prisma.CustomerWhereInput = {
  NOT: { emailVerifiedAt: null, relayUnverifiedSince: { not: null } },
};

/** At most this many sessions for an unverified account; a further
 * sign-in signs out the one used least recently (F17). */
export const UNVERIFIED_SESSION_CAP = 3;

/** Changing the unverified address: at most this many a day. */
export const ADDRESS_CHANGES_PER_DAY = 3;

/** An unpaid, unverified relay account idle this long is deleted. */
export const UNVERIFIED_IDLE_MS = 30 * 86_400_000;
/** Sweeps stay paused this long after a declared intranet ends. */
export const INTRANET_GRACE_MS = 30 * 86_400_000;

/** Auto detector (R2.5). */
export const DETECTOR_ALERT_AFTER_MS = 30 * 60_000;
export const DETECTOR_RAISE_AFTER_MS = 60 * 60_000;

export function powBits(signs: { ipLastHour: number; globalLastHour: number; installToday: number }): number {
  let steps = 0;
  if (signs.ipLastHour >= POW_IP_HOURLY) steps += 1;
  if (signs.globalLastHour >= POW_GLOBAL_HOURLY) steps += 1;
  if (signs.installToday >= POW_INSTALL_DAILY) steps += 1;
  return POW_FLOOR_BITS + steps * POW_STEP_BITS;
}

export interface CapCounts {
  /** Sign-ups today, all networks. */
  total: number;
  /** Sign-ups today on this caller's network. */
  network: number;
  /** Sign-ups today on every listed hosting network together. */
  hosting: number;
  /** Sign-ups today from this caller. */
  caller: number;
}

export type CapRefusal = "global" | "network" | "hosting" | "caller";

/** Which cap, if any, one more sign-up would break. */
export function capRefusal(tier: RelayTier, isHosting: boolean, counts: CapCounts): CapRefusal | null {
  const cap = GLOBAL_DAILY_CAP[tier];
  if (counts.total >= cap) return "global";
  if (counts.caller >= IP_DAILY_CAP) return "caller";
  if (isHosting) {
    if (counts.hosting >= Math.floor(cap * HOSTING_SHARE)) return "hosting";
  } else if (counts.network >= Math.floor(cap * ASN_SHARE)) {
    return "network";
  }
  return null;
}

// --------------------------------------------------------------- detector

export const BUCKET_MS = 10 * 60_000;
const WINDOW_BUCKETS = 3;
const DAY_MS = 86_400_000;
const BASELINE_DAYS = 7;
/** Fewer days than this with any traffic at all is no baseline. */
const MIN_BASELINE_DAYS = 4;
/** A median half-hour below this many requests is too quiet to judge. */
const MIN_BASELINE_REQUESTS = 20;
const IR_DROP = 0.15;
const OTHER_HOLDS = 0.7;

export interface TrafficCounts {
  ir: number;
  other: number;
}

export function bucketStart(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface DropReading {
  ir: number;
  other: number;
  irMedian: number;
  otherMedian: number;
  /** Iranian traffic on the normal routes has fallen away while the rest
   * of the world's has not -- the signature of Iran's international links
   * being cut, rather than of our own outage, which would take both. */
  holds: boolean;
}

/** The last complete half hour against the same half hour on each of the
 * previous seven days. `buckets` is keyed by bucket start (ms). */
export function evaluateDrop(buckets: Map<number, TrafficCounts>, now: number): DropReading {
  const end = bucketStart(now);
  const window = (offset: number): TrafficCounts => {
    const sum = { ir: 0, other: 0 };
    for (let i = 1; i <= WINDOW_BUCKETS; i += 1) {
      const b = buckets.get(end - offset - i * BUCKET_MS);
      if (b) {
        sum.ir += b.ir;
        sum.other += b.other;
      }
    }
    return sum;
  };
  const current = window(0);
  const past = Array.from({ length: BASELINE_DAYS }, (_, d) => window((d + 1) * DAY_MS));
  const irMedian = median(past.map((p) => p.ir));
  const otherMedian = median(past.map((p) => p.other));
  const daysWithData = past.filter((p) => p.ir + p.other > 0).length;
  const holds =
    daysWithData >= MIN_BASELINE_DAYS &&
    irMedian >= MIN_BASELINE_REQUESTS &&
    otherMedian >= MIN_BASELINE_REQUESTS &&
    current.ir < IR_DROP * irMedian &&
    current.other >= OTHER_HOLDS * otherMedian;
  return { ...current, irMedian, otherMedian, holds };
}

export interface SuspicionState {
  suspectedSince: Date | null;
  suspicionAlertedAt: Date | null;
  capsRaisedAt: Date | null;
}

export type SuspicionEvent = "alert" | "raise" | "clear";

/** One step of the auto detector: alert the owner after half an hour of
 * the drop, raise the caps after an hour, and stand both down when it
 * ends. Nothing a customer reads changes here (I4, F6). */
export function stepSuspicion(
  prev: SuspicionState,
  holds: boolean,
  now: Date,
): { next: SuspicionState; events: SuspicionEvent[] } {
  if (!holds) {
    if (!prev.suspectedSince) return { next: prev, events: [] };
    return {
      next: { suspectedSince: null, suspicionAlertedAt: null, capsRaisedAt: null },
      events: prev.suspicionAlertedAt ? ["clear"] : [],
    };
  }
  const since = prev.suspectedSince ?? now;
  const next: SuspicionState = { ...prev, suspectedSince: since };
  const events: SuspicionEvent[] = [];
  const held = now.getTime() - since.getTime();
  if (!prev.suspicionAlertedAt && held >= DETECTOR_ALERT_AFTER_MS) {
    next.suspicionAlertedAt = now;
    events.push("alert");
  }
  if (!prev.capsRaisedAt && held >= DETECTOR_RAISE_AFTER_MS) {
    next.capsRaisedAt = now;
    events.push("raise");
  }
  return { next, events };
}
