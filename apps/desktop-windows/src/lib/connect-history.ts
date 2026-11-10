import type { Dial } from "./attempts";
import type { EgressVerdict } from "./egress";
import type { Protocol } from "./types";

/** What has actually worked on this device, lately.
 *
 * `failover.lastGood` already remembers one route per network, and that
 * is as far as the memory went: no protocol, no timestamp, and no
 * record of anything that *failed*. Everything after it fell back to a
 * fixed `PROTOCOL_ORDER` that is identical for every customer.
 *
 * That ordering cannot be right for Iran, and the reason is specific.
 * Two people on the same ISP do not get the same filtering -- it varies
 * by subscriber, by region, by which CGNAT egress they land on -- and
 * what works changes from one day to the next. So an order derived from
 * anyone else's experience, or from last week's, is a guess. The only
 * evidence that matches a customer's actual situation is their own
 * device's, from the last few hours.
 *
 * Which is what this is. It never leaves the machine, so there is no
 * privacy cost to keeping it and no network cost to reading it.
 *
 * It deliberately does *not* replace the customer's own choice. Picking
 * a server in the list still leads; this decides what comes after.
 */

/** One attempt, as thin as it can be: when, and whether it worked --
 * and, where the data check measured it (`data-check.ts`), how fast its
 * slower direction went, in kilobits a second. On a rung that landed,
 * that figure is replaced by the download sampled once the app said
 * "Connected" (`sampleDownload`), where one could be taken: a second and
 * a half through the tunnel, against the check's 128 KB, which a good
 * line is through in a few round trips.
 *
 * `dead` marks a rung that came up and carried nothing, or did not
 * connect (`recordDead`). Not every `ok: false` is one: a rung that was
 * only slow carried data, and a landing nothing could confirm proved
 * nothing either way.
 *
 * `up` is the upload alone, in kilobits a second, on an attempt whose
 * data check passed (`recordUpload`). `kbps` cannot stand in for it: it
 * is the slower direction, and after the sample it may be the download.
 * What it is for is the line, not the rung -- how fast uploads that work
 * go on this network (`typicalUploadKbps`). */
export type Attempt = { at: number; ok: boolean; kbps?: number; dead?: true; up?: number };

/** Keyed `network|routeId|protocol`. Newest last. */
export type ConnectHistory = Record<string, Attempt[]>;

export const CONNECT_HISTORY_STORE_KEY = "failover.history";

/** How many attempts are kept per combination.
 *
 * Enough to ride out one unlucky failure, few enough that a run of
 * successes from yesterday cannot outvote a failure from ten minutes
 * ago once the weighting is applied.
 */
export const KEEP_PER_KEY = 8;

/** How many combinations are kept in total.
 *
 * Routes times protocols times networks grows without bound otherwise,
 * and a store that grows forever on someone's machine is a bug with a
 * long fuse. The least recently touched go first.
 */
export const KEEP_KEYS = 400;

/** How far back a prune cuts once the ceiling is reached.
 *
 * Three quarters, so roughly a hundred inserts pass before the next
 * sort rather than every single one of them paying for it.
 */
export const PRUNE_TO = 300;

/** How fast evidence stops counting.
 *
 * Twelve hours, so something that worked this morning still carries
 * weight this evening, yesterday counts for a quarter, and the day
 * before is nearly nothing. Chosen from the thing being measured: Ali
 * reports filtering that changes day to day, so evidence older than
 * about a day is describing a network that no longer exists.
 */
export const HALF_LIFE_MS = 12 * 60 * 60 * 1000;

function keyFor(network: string | null, routeId: string, protocol: Protocol): string {
  // An unknown network shares one bucket rather than being given a
  // fabricated identity, which would file the memory under the wrong
  // place -- the same choice `failover.lastGood` makes.
  return `${network ?? "unknown"}|${routeId}|${protocol}`;
}

/** Adds one result, bounded on write. */
export function recordAttempt(
  history: ConnectHistory,
  network: string | null,
  routeId: string,
  protocol: Protocol,
  ok: boolean,
  now: number = Date.now(),
): ConnectHistory {
  return append(history, keyFor(network, routeId, protocol), { at: now, ok });
}

/** Adds a rung that came up and carried nothing, or did not connect: a
 * failure like any other to `scoreFor`, and marked, so the next pass on
 * this network can leave it until last (`failedLately`). */
export function recordDead(
  history: ConnectHistory,
  network: string | null,
  routeId: string,
  protocol: Protocol,
  now: number = Date.now(),
): ConnectHistory {
  return append(history, keyFor(network, routeId, protocol), { at: now, ok: false, dead: true });
}

/** How a rung the ladder moved on from ended, for `rungShownDead`. */
export type RungEnd =
  /** Its tunnel came up: what the address check through it came to, or
   * null where none ran -- Custom mode on Windows, whose own probe says
   * nothing about the protocol. */
  | { up: true; egress: EgressVerdict["state"] | null }
  /** It did not connect: the dial the report counts for it, null where
   * the failure was the account's or the device's (`failedDial`). */
  | { up: false; dial: Dial };

/** Whether a rung the ladder moved on from is to be remembered as dead
 * on this network (`recordDead`). Both ladders ask it; on the phone a
 * rung that came up has been through `rejectionIsEvidence`, the same
 * rule, by then.
 *
 * A mark sends the rung behind every other for hours (`failedLately`),
 * so it takes a measurement, and the ladder moves on from more than it
 * measures:
 *
 * - Came up, and the address check measured it carrying nothing: the old
 *   address came back, or nothing answered at all. Not `indeterminate`,
 *   which is our own API silent under a tunnel that plainly carries
 *   traffic -- a backend being redeployed -- and not a rung with no such
 *   check behind it.
 * - Did not connect, for a reason that is the network's.
 * - And never once the pass has been told to stop: the stop takes the
 *   tunnel down at once, and a check still running then reads the bare
 *   network, a dial still running fails. The Windows ladder marked the
 *   customer's usual rung dead for a press of Stop during its check. */
export function rungShownDead(end: RungEnd, stopped: boolean): boolean {
  if (stopped) return false;
  if (!end.up) return end.dial !== null;
  return end.egress === "bypassingTunnel" || end.egress === "unreachable";
}

function append(history: ConnectHistory, key: string, attempt: Attempt): ConnectHistory {
  const kept = [...(history[key] ?? []), attempt].slice(-KEEP_PER_KEY);
  const next: ConnectHistory = { ...history, [key]: kept };

  if (Object.keys(next).length <= KEEP_KEYS) return next;

  // Pruned down to the low-water mark, not back to the ceiling.
  //
  // Trimming to exactly `KEEP_KEYS` leaves the map full, so the *next*
  // insert is over again and sorts every entry a second time -- and so
  // does the one after that, for ever. Cutting deeper buys a run of
  // cheap inserts before the next sort, which turns a cost paid on
  // every call into one paid occasionally.
  //
  // Indexed rather than `.at(-1)`: these tsconfigs target ES2021 and
  // raising the lib would reach every `@shared` consumer, which is a
  // lot of blast radius for one array access.
  const newest = (a: Attempt[]): number => (a.length === 0 ? 0 : a[a.length - 1].at);
  const byRecency = Object.entries(next).sort((a, b) => newest(b[1]) - newest(a[1]));
  return Object.fromEntries(byRecency.slice(0, PRUNE_TO));
}

/** How well this combination has been going, or `null` for no evidence.
 *
 * Returns 0..1, weighted so recent attempts dominate. `null` rather
 * than a neutral number on purpose: "nothing is known" and "known to be
 * an even split" must order differently, and a caller that cannot tell
 * them apart would rank an untried protocol above one that has been
 * failing all afternoon.
 */
export function scoreFor(
  history: ConnectHistory,
  network: string | null,
  routeId: string,
  protocol: Protocol,
  now: number = Date.now(),
): number | null {
  const attempts = history[keyFor(network, routeId, protocol)];
  if (!attempts || attempts.length === 0) return null;

  let weighted = 0;
  let total = 0;
  for (const { at, ok } of attempts) {
    // Future-stamped entries (a clock that moved) weigh as "now" rather
    // than more than now.
    const age = Math.max(0, now - at);
    const weight = Math.pow(0.5, age / HALF_LIFE_MS);
    total += weight;
    if (ok) weighted += weight;
  }
  // Everything has decayed past counting. Evidence this old is not
  // evidence about this network any more.
  if (total < 1e-6) return null;
  return weighted / total;
}

/** The newest attempt for this combination, or `null` when there is none.
 *
 * The array is newest-last as written, but this does not rely on it: a
 * store merged from an older client, or a clock that moved, could leave
 * the order otherwise. For the main page's map (`map-lights.ts`), which
 * asks a narrower question than `scoreFor` -- did the latest try here
 * carry traffic -- rather than a weighted average. */
export function latestAttempt(
  history: ConnectHistory,
  network: string | null,
  routeId: string,
  protocol: Protocol,
): Attempt | null {
  const attempts = history[keyFor(network, routeId, protocol)];
  if (!attempts || attempts.length === 0) return null;
  let newest = attempts[0];
  for (const attempt of attempts) if (attempt.at >= newest.at) newest = attempt;
  return newest;
}

/** Stamps the speed the data check measured onto this combination's
 * newest attempt -- the one just recorded for the same rung. */
export function recordSpeed(
  history: ConnectHistory,
  network: string | null,
  routeId: string,
  protocol: Protocol,
  kbps: number,
): ConnectHistory {
  const key = keyFor(network, routeId, protocol);
  const attempts = history[key];
  if (!attempts || attempts.length === 0 || !(kbps >= 0)) return history;
  const stamped = attempts.map((attempt, i) => (i === attempts.length - 1 ? { ...attempt, kbps: Math.round(kbps) } : attempt));
  return { ...history, [key]: stamped };
}

/** Stamps the upload a passed data check measured onto this
 * combination's newest attempt -- the one just recorded for the same
 * rung, as `recordSpeed` does. Only for a check that passed
 * (`passedUploadKbps` in data-check.ts): an upload that ran out of time
 * has no figure, and what a slow rung managed is not what this network's
 * working uploads look like. */
export function recordUpload(
  history: ConnectHistory,
  network: string | null,
  routeId: string,
  protocol: Protocol,
  upKbps: number,
): ConnectHistory {
  const key = keyFor(network, routeId, protocol);
  const attempts = history[key];
  if (!attempts || attempts.length === 0 || !(upKbps > 0)) return history;
  const stamped = attempts.map((attempt, i) => (i === attempts.length - 1 ? { ...attempt, up: Math.round(upKbps) } : attempt));
  return { ...history, [key]: stamped };
}

/** How many of a network's latest passing uploads say what is typical
 * there. A few: enough that one odd reading -- a burst, a busy minute --
 * is outvoted, few enough that a line that has changed is believed
 * within a handful of connects. */
export const UPLOADS_COUNTED = 5;

/** How long a passing upload says anything about a network's line.
 *
 * A week, not the day the rest of this memory lasts (`SPEED_FRESH_MS`).
 * That day is about filtering, which changes overnight; this is about
 * how fast the customer's own line uploads, which does not. And the
 * customer it is for connects on a line where the check reads slow half
 * the time: forgotten after a day, somebody who connects every other
 * day would never have it. What it costs when it is stale is bounded --
 * a few seconds more for a rung that is slow (`UP_LEG_MAX_MS`). */
export const UPLOAD_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** How fast uploads that passed the data check have gone on this network
 * lately, in kilobits a second, or `null` when none is remembered: the
 * middle of the latest `UPLOADS_COUNTED`, on any server and protocol,
 * from the last `UPLOAD_FRESH_MS`.
 *
 * The network's, not a rung's, because it is the line being measured:
 * every working server here uploads through the same one. With an even
 * count the higher of the middle two -- the reading that asks more of
 * the next rung, since a lower one gives its upload longer
 * (`uploadLegMs` in data-check.ts).
 *
 * Nothing for a network that is not known: every such network shares one
 * bucket here, and one slow line must not speak for all of them. */
export function typicalUploadKbps(history: ConnectHistory, network: string | null, now: number = Date.now()): number | null {
  if (network === null) return null;
  const prefix = `${network}|`;
  const passed: Array<{ at: number; up: number }> = [];
  for (const [key, attempts] of Object.entries(history)) {
    if (!key.startsWith(prefix)) continue;
    for (const attempt of attempts) {
      if (!attempt.ok || attempt.up === undefined || !(attempt.up > 0)) continue;
      if (now - attempt.at > UPLOAD_FRESH_MS) continue;
      passed.push({ at: attempt.at, up: attempt.up });
    }
  }
  if (passed.length === 0) return null;
  const latest = passed
    .sort((a, b) => b.at - a.at)
    .slice(0, UPLOADS_COUNTED)
    .map((one) => one.up)
    .sort((a, b) => a - b);
  return latest[Math.floor(latest.length / 2)];
}

/** How long a measured speed says anything about a network. */
export const SPEED_FRESH_MS = 2 * HALF_LIFE_MS;

/** The newest measured speed for this combination, or `null` when none
 * was measured in the last `SPEED_FRESH_MS`. */
export function speedFor(
  history: ConnectHistory,
  network: string | null,
  routeId: string,
  protocol: Protocol,
  now: number = Date.now(),
): number | null {
  const attempts = history[keyFor(network, routeId, protocol)] ?? [];
  let newest: Attempt | null = null;
  for (const attempt of attempts) {
    if (attempt.kbps === undefined || now - attempt.at > SPEED_FRESH_MS) continue;
    if (newest === null || attempt.at >= newest.at) newest = attempt;
  }
  return newest?.kbps ?? null;
}

/** Whether this combination carried traffic on this network lately: any
 * verified attempt in the last `SPEED_FRESH_MS`. Looser than `scoreFor`
 * on purpose -- a server that read slow on its last two tries and moved
 * on the one before scores under one never tried, and is still the
 * likelier of the two to move. For a pass with little left to spend
 * (`searchOrder` in data-check.ts). */
export function workedLately(
  history: ConnectHistory,
  network: string | null,
  routeId: string,
  protocol: Protocol,
  now: number = Date.now(),
): boolean {
  const attempts = history[keyFor(network, routeId, protocol)] ?? [];
  return attempts.some((attempt) => attempt.ok && now - attempt.at <= SPEED_FRESH_MS);
}

/** Whether this combination passed the data check on this network
 * lately: a verified attempt in the last `SPEED_FRESH_MS` with a speed
 * measured in both directions (`rememberedKbps` is the slower one, and
 * nothing for a check that could not be run).
 *
 * Stricter than `workedLately`, for the one question that needs it:
 * whether a rung that reads slow now is a server that works here having
 * a slow moment, or one whose upload is held (`noteSlow` in
 * data-check.ts). A held server never passes the check, so it is never
 * this -- but it can land as verified where the check was not run at
 * all, and that landing must not vouch for it. */
export function movedLately(
  history: ConnectHistory,
  network: string | null,
  routeId: string,
  protocol: Protocol,
  now: number = Date.now(),
): boolean {
  const attempts = history[keyFor(network, routeId, protocol)] ?? [];
  return attempts.some(
    (attempt) => attempt.ok && attempt.kbps !== undefined && attempt.kbps > 0 && now - attempt.at <= SPEED_FRESH_MS,
  );
}

/** How long a rung that failed on a network is left until last there.
 *
 * A few hours: long enough that somebody reconnecting through an evening
 * does not pay for the same dead rungs on every pass, short enough that
 * a block lifted overnight is found by the morning. Order only -- the
 * rung is still dialled, after the others. */
export const FAILED_LAST_MS = 6 * 60 * 60 * 1000;

/** Whether this combination has only failed on this network lately: tried
 * in the last `FAILED_LAST_MS`, every time it came up and carried
 * nothing or did not connect (`recordDead`), and not seen carrying
 * traffic here in the last day (`workedLately`).
 *
 * Every time, not the last time, and only `dead` attempts count -- a rung
 * that was slow carried data, and a landing that could not be confirmed
 * is not known to have failed.
 *
 * And never a rung that worked here within the day, however it has
 * failed since: that is left to `scoreFor`, which weighs the two, as it
 * was before this existed. One failure used to be enough once the last
 * success was six hours old, so the customer's usual rung, landed in the
 * morning, went behind every other rung for six hours on one press of
 * Connect during a short outage -- and on a network where most servers
 * carry nothing, that is most of the ladder at 25-30 s a rung. What this
 * is for is the rung that has not worked here at all lately. The cost: a
 * server cut off today keeps the place it had for up to a day after it
 * last worked, as it did before.
 *
 * Still one failure for a rung whose last success here is over a day
 * old: evidence that old describes a network that may no longer exist
 * (`HALF_LIFE_MS`). */
export function failedLately(
  history: ConnectHistory,
  network: string | null,
  routeId: string,
  protocol: Protocol,
  now: number = Date.now(),
): boolean {
  const attempts = history[keyFor(network, routeId, protocol)] ?? [];
  const recent = attempts.filter((attempt) => now - attempt.at <= FAILED_LAST_MS);
  if (recent.length === 0 || !recent.every((attempt) => attempt.dead === true)) return false;
  return !workedLately(history, network, routeId, protocol, now);
}

/** Forgets everything recorded against one network.
 *
 * For the case where the customer knows the situation changed and the
 * app does not -- switching SIM, or a filter lifting. Cheaper to offer
 * than to detect.
 */
export function forgetNetwork(history: ConnectHistory, network: string | null): ConnectHistory {
  const prefix = `${network ?? "unknown"}|`;
  return Object.fromEntries(Object.entries(history).filter(([k]) => !k.startsWith(prefix)));
}
