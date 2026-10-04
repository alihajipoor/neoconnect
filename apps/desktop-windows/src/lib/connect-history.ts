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

/** One attempt, as thin as it can be: when, and whether it worked. */
export type Attempt = { at: number; ok: boolean };

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
  const key = keyFor(network, routeId, protocol);
  const kept = [...(history[key] ?? []), { at: now, ok }].slice(-KEEP_PER_KEY);
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
