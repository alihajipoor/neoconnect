import { load, type Store } from "@tauri-apps/plugin-store";
import type { ProtocolUser, RouteOption, Subscription } from "./types";

/** The last known good answer from the control plane, kept so the app can
 * connect without it.
 *
 * The reason this exists is the reason protocol failover exists, one
 * layer down. A customer whose subscription has not changed in weeks, and
 * whose nodes are perfectly reachable, could not connect at all if the
 * API was unreachable -- the app asked for credentials it had already
 * been given, failed, and stopped. That happened for real: the panel's
 * address was filtered in Iran and the product was dead for everyone
 * there, on every protocol, on every node.
 *
 * An unreachable control plane should cost the things that genuinely need
 * a server -- buying a plan, seeing today's usage, switching servers --
 * and nothing else. Connecting is not one of them: since every route a
 * plan allows is provisioned up front, the credentials in hand are
 * already the whole ladder.
 *
 * On what is stored: these are the same secrets the app already writes to
 * disk to connect at all -- a WireGuard private key ends up in a config
 * file either way -- and they sit in the app's own data directory beside
 * session.json, with the same per-user file permissions. The exposure is
 * not new. What is new is that they survive the app closing, which is the
 * entire point.
 */
export interface ConnectionSnapshot {
  /** Bumped when the shape changes, so an older cache is discarded rather
   * than misread. Cheaper than migrating something that rebuilds itself
   * on the next successful fetch. */
  version: 1;
  savedAt: number;
  subscription: Subscription | null;
  protocolUsers: ProtocolUser[];
  routes: RouteOption[];
}

const VERSION = 1 as const;
const KEY = "snapshot";

/** How long a snapshot is treated as describing the servers as they are
 * now.
 *
 * Read the name carefully: this is a *freshness horizon*, not an expiry.
 * Nothing here ever deletes or refuses a snapshot for being old, and
 * `loadSnapshot` returns a week-old one exactly as readily as a
 * ten-second-old one. That is deliberate and non-negotiable -- the whole
 * reason this file exists is that a customer in Iran whose control plane
 * is filtered must still be able to connect, and a cache that expired
 * itself would reintroduce the outage it was written to end.
 *
 * What the TTL does is tell the connect path whether it is entitled to
 * dial on what it already holds, or owes the server one small question
 * first. See `refreshConnectionConfig` in connection-config.ts.
 *
 * Ten minutes, and the number comes from what it is protecting against.
 * A server-side change that clients cannot be told about -- a REALITY
 * decoy SNI being moved off cloudflare.com, which is the change this was
 * written for -- strands every client still holding the old value, and
 * the strand lasts until something refetches. Before this, on Android,
 * that was "until the app is restarted", which is unbounded: the WebView
 * survives backgrounding and adopts a running tunnel on open, so
 * toggling the VPN off and on re-dialled the same dead SNI forever.
 *
 * Ten minutes bounds the window at one coffee break rather than one
 * reinstall, while being long enough that the common case -- open the
 * app, press Connect, press it again after a hiccup -- costs one request
 * and not three. It is not a poll: nothing wakes up on this interval.
 * It is only ever consulted at the moment somebody is about to connect
 * or has just brought the app back to the foreground.
 */
export const SNAPSHOT_TTL_MS = 10 * 60_000;

/** Whether a snapshot is past the freshness horizon.
 *
 * A snapshot with no usable `savedAt` counts as stale: an unknown age is
 * not evidence of youth, and treating it as fresh is how a cache written
 * by an older build would silently opt out of every refresh.
 */
export function isSnapshotStale(snapshot: Pick<ConnectionSnapshot, "savedAt"> | null, now = Date.now()): boolean {
  if (!snapshot) return true;
  if (typeof snapshot.savedAt !== "number" || snapshot.savedAt <= 0) return true;
  // A savedAt in the future is a clock that moved backwards, not a
  // snapshot from the future. Refetching is the cheap, safe answer.
  if (snapshot.savedAt > now) return true;
  return now - snapshot.savedAt > SNAPSHOT_TTL_MS;
}

/** Its own file rather than session.json.
 *
 * Signing out clears the session; it must also clear this, and keeping
 * them separate makes that an explicit decision rather than a side
 * effect of how one file happens to be written. */
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // A rejected promise must not be cached, or one transient failure
  // breaks saving for the life of the process.
  storePromise ??= load("connection-cache.json", { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

/** Records what the server just said. Best-effort: a cache that cannot be
 * written must never fail the fetch that succeeded.
 *
 * `stillCurrent`, when given, is asked at the last moment before the
 * write: whether the customer whose answer this is is still the one
 * signed in. A load that was in flight when they signed out used to
 * write their credentials -- WireGuard keys, passwords -- back to disk
 * after the sign-out had cleared them, for the next person on the
 * machine to be shown or to connect with. A predicate rather than an
 * import of the session's generation, because session-end already
 * imports this file. */
export async function saveSnapshot(
  snapshot: Omit<ConnectionSnapshot, "version" | "savedAt">,
  stillCurrent?: () => boolean,
): Promise<void> {
  try {
    const store = await getStore();
    if (stillCurrent && !stillCurrent()) return;
    await store.set(KEY, { ...snapshot, version: VERSION, savedAt: Date.now() });
    await store.save();
  } catch {
    // Nothing to do and nothing worth telling the customer: the app is
    // working, it simply will not have this to fall back on later.
  }
}

/** The last good answer, or null.
 *
 * Read defensively. This file survives across app versions and is the
 * input to the connect path, so a malformed or partial cache has to
 * become "no cache" rather than a half-populated object that fails
 * somewhere further in with a confusing message.
 */
export async function loadSnapshot(): Promise<ConnectionSnapshot | null> {
  try {
    const store = await getStore();
    const stored = await store.get<ConnectionSnapshot>(KEY);
    if (!stored || stored.version !== VERSION) return null;
    if (!Array.isArray(stored.protocolUsers) || stored.protocolUsers.length === 0) return null;
    // A credential with no connection block cannot build a tunnel, and
    // one that got that far would fail with a missing-field error rather
    // than an honest "no saved servers".
    if (!stored.protocolUsers.every((u) => u && u.connection && u.protocol)) return null;
    return {
      version: VERSION,
      savedAt: typeof stored.savedAt === "number" ? stored.savedAt : 0,
      subscription: stored.subscription ?? null,
      protocolUsers: stored.protocolUsers,
      routes: Array.isArray(stored.routes) ? stored.routes.map(withoutNetworkTag) : [],
    };
  } catch {
    return null;
  }
}

/** A cached route without its `ispTag`.
 *
 * The tag is the server's word on how the route has done for people on
 * the network the list was fetched from -- worked out from the request's
 * network attestation -- and a cached list is shown on whatever network
 * the device is on now. Kept, a list cached on home Wi-Fi told a customer
 * on mobile data that a server had been failing for most people on their
 * network, or working, as if it had been measured there, and the
 * picker's "only what worked on my network" filtered by it; and every
 * load carried the list forward with a fresh time, so a tag could be days
 * old. The picker's own refresh is the only source of tags now. Read off
 * on the way out of the cache, so every use of a cached list -- the
 * offline start, a failed list's stand-in, the snapshot written from it
 * -- is without them. */
function withoutNetworkTag(route: RouteOption): RouteOption {
  if (route === null || typeof route !== "object" || !("ispTag" in route)) return route;
  const { ispTag: _measuredElsewhere, ...rest } = route;
  return rest;
}

/** Replaces just the credentials, keeping the subscription and routes
 * that are already cached.
 *
 * The pre-connect refresh asks for one thing only -- the protocol users,
 * because that is where a server's address, port and REALITY SNI live --
 * so it must not write a snapshot at all through `saveSnapshot`, which
 * takes the whole object. Doing that would null out the subscription and
 * empty the route list, and the next offline start would come up with no
 * plan and an empty location picker: a strictly worse cache written by a
 * *successful* fetch.
 *
 * Refuses to write when there is nothing cached yet. A snapshot with
 * credentials and no subscription is a shape `loadSnapshot` would hand
 * back and the offline path would then render as a customer with no
 * plan; the full `loadAll` will write a complete one soon enough.
 *
 * `stillCurrent` is `saveSnapshot`'s. It matters more here than there,
 * because the refresh's answer may come in long after it was asked for:
 * after a sign-out and the next customer's sign-in, the snapshot this
 * reads is theirs, and without the check one customer's credentials
 * would be written into the other's.
 *
 * `askedAt`, when given, is when the credentials were asked for, and a
 * snapshot saved since then is not written over: it was written by
 * something that asked later -- a load after a server switch, holding the
 * credential the switch provisioned. A refresh's answer that came in late,
 * after a switch made meanwhile, used to put the list from before the
 * switch back, with a fresh time on it; for the next ten minutes every
 * connect dialled it without asking, and put the customer on another
 * server. Returns whether it wrote, or found a newer snapshot and did
 * not (`superseded`), or had nothing to write into.
 */
export async function updateSnapshotProtocolUsers(
  protocolUsers: ProtocolUser[],
  stillCurrent?: () => boolean,
  askedAt?: number,
): Promise<"written" | "superseded" | "skipped"> {
  if (protocolUsers.length === 0) return "skipped";
  const existing = await loadSnapshot();
  if (!existing) return "skipped";
  if (askedAt !== undefined && existing.savedAt > askedAt) return "superseded";
  await saveSnapshot(
    {
      subscription: existing.subscription,
      protocolUsers,
      routes: existing.routes,
    },
    stillCurrent,
  );
  return "written";
}

/** The cached server list, for a load whose route request failed while
 * everything else it asked for answered.
 *
 * The list is the one thing a load asks for separately, after the
 * credentials and the plan, so it can fail on its own -- a network that
 * answered three requests and lost the fourth. Such a load used to cache
 * an empty list beside the fresh credentials, and the next start with
 * Neoxify out of reach had no servers to show: the picker opened on
 * "Could not reach Neoxify" over servers that were perfectly reachable,
 * with their credentials in hand. That is the picker testers on censored
 * networks have described; whether this is what produced it is not
 * established, since the test machine's route requests always answered.
 *
 * Only this plan's list. Routes belong to a subscription, and changing
 * plans is a new subscription, so a list cached for another one, or for
 * this one before its plan was changed, would offer servers the plan may
 * not include. Nothing is better than that: the picker then says honestly
 * that it could not get the list, and a pick it cannot honour is never
 * offered.
 *
 * Empty when nothing usable is cached, which is what the load wrote
 * before, so the worst case is the old behaviour. */
export async function cachedRoutesFor(subscription: Subscription): Promise<RouteOption[]> {
  const snapshot = await loadSnapshot();
  const held = snapshot?.subscription;
  if (!snapshot || !held) return [];
  if (held.id !== subscription.id || held.planId !== subscription.planId) return [];
  return snapshot.routes;
}

/** Which plan a route list belongs to: a subscription, and the plan it
 * is on. A plan change is a new list (`cachedRoutesFor`). */
export function planOf(subscription: Pick<Subscription, "id" | "planId">): string {
  return `${subscription.id}:${subscription.planId}`;
}

/** The route list on a dashboard: which plan it is for, and which of the
 * screen's loads put it there, by the order they started in. */
export interface ShownRoutes {
  plan: string | null;
  load: number;
}

/** What a dashboard's load whose route request failed puts on screen, or
 * null to leave the list there as it is. `cached` is the list cached for
 * this plan (`cachedRoutesFor`); `load` is this load's place in the order.
 *
 *  - A later load has put its own list on screen meanwhile: null. Its list
 *    is newer than anything this one could find in the cache, which may
 *    not yet hold it -- it is written without waiting.
 *  - A list cached for this plan: that.
 *  - Nothing cached for it: the list on screen stays if it is this plan's,
 *    and goes if it is another's. A failed request never blanks a list
 *    the customer can use, but one for another plan cannot be used:
 *    picked from, it switches to a route the plan does not have, which the
 *    server refuses. The phone's picker opens on the dashboard's list now,
 *    as the desktop's does, and would have offered it. */
export function standInRoutes(cached: RouteOption[], shown: ShownRoutes, plan: string, load: number): RouteOption[] | null {
  if (shown.load > load) return null;
  if (cached.length > 0) return cached;
  return shown.plan === plan ? null : [];
}

/** Forgets everything. Called on sign-out: leaving one customer's
 * credentials on the machine for the next person to connect with is not
 * a cache, it is a leak. */
export async function clearSnapshot(): Promise<void> {
  try {
    const store = await getStore();
    await store.delete(KEY);
    await store.save();
  } catch {
    // Same reasoning as save: nothing useful to do about it here.
  }
}
