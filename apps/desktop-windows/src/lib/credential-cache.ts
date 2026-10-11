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
  /** When the credentials in it were asked for: what decides whether a
   * refresh's late answer is newer (`updateSnapshotProtocolUsers`). The
   * time it was saved, for a snapshot from before it was kept. */
  askedAt?: number;
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
 * imports this file.
 *
 * `savedAt` is now unless given. Given only by a write that leaves the
 * credentials and the plan as they were (`updateSnapshotRoutes`): the time
 * is what says how fresh they are (`isSnapshotStale`), and what the offline
 * banner says they were last updated. */
export async function saveSnapshot(
  snapshot: Omit<ConnectionSnapshot, "version" | "savedAt"> & { savedAt?: number },
  stillCurrent?: () => boolean,
): Promise<void> {
  try {
    const store = await getStore();
    if (stillCurrent && !stillCurrent()) return;
    const savedAt = snapshot.savedAt ?? Date.now();
    await store.set(KEY, { ...snapshot, version: VERSION, savedAt, askedAt: snapshot.askedAt ?? savedAt });
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
    const savedAt = typeof stored.savedAt === "number" ? stored.savedAt : 0;
    return {
      version: VERSION,
      savedAt,
      askedAt: typeof stored.askedAt === "number" ? stored.askedAt : savedAt,
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
 * `askedAt`, when given, is when the credentials were asked for, and
 * credentials asked for since then are not written over: they were asked
 * for by something later -- a load after a server switch, holding the
 * credential the switch provisioned. A refresh's answer that came in late,
 * after a switch made meanwhile, used to put the list from before the
 * switch back, with a fresh time on it; for the next ten minutes every
 * connect dialled it without asking, and put the customer on another
 * server. Returns whether it wrote, or found newer credentials and did
 * not (`superseded`), or had nothing to write into.
 *
 * Newer by when they were asked for, not by when they were written.
 * Compared with the snapshot's save time, the first of two late answers to
 * land, which was the older, wrote it, and the newer was then thrown away
 * as superseded. And compared with what is in hand as well as what is on
 * disk (`noteCredentialsShown`): a newer answer's write is not awaited by
 * whoever adopts it, and an older late answer read the snapshot before
 * that write had landed, passed, and was put on screen over the newer one. */
export async function updateSnapshotProtocolUsers(
  protocolUsers: ProtocolUser[],
  stillCurrent?: () => boolean,
  askedAt?: number,
): Promise<"written" | "superseded" | "skipped"> {
  if (protocolUsers.length === 0) return "skipped";
  // Before anything is awaited, so whatever happens meanwhile is ordered
  // against these.
  if (askedAt !== undefined) {
    if (askedAt < newestShown) return "superseded";
    noteCredentialsShown(askedAt);
  }
  const existing = await loadSnapshot();
  if (!existing) return "skipped";
  if (askedAt !== undefined && (existing.askedAt ?? existing.savedAt) > askedAt) return "superseded";
  await saveSnapshot(
    {
      subscription: existing.subscription,
      protocolUsers,
      routes: existing.routes,
      ...(askedAt !== undefined ? { askedAt } : {}),
    },
    stillCurrent,
  );
  return "written";
}

/** When the newest credentials adopted in this run were asked for: put on
 * a screen by a load, or kept from a refresh (`noteCredentialsShown`). */
let newestShown = -Infinity;

/** Records that credentials asked for at `askedAt` are now what a screen
 * holds, or what the cache is about to: a refresh's late answer asked for
 * before them is older, and is neither written nor put on a screen
 * (`updateSnapshotProtocolUsers`). Called by a dashboard's load the moment
 * it puts its answer on screen, which is before it writes the snapshot --
 * the route list is asked for in between, for up to twenty seconds. A late
 * answer from before a server switch, landing in that window, replaced the
 * switched list on screen, and the next connect inside the freshness
 * horizon dialled it, without the route the switch had provisioned. */
export function noteCredentialsShown(askedAt: number): void {
  if (askedAt > newestShown) newestShown = askedAt;
}

/** For tests: forget what this run has adopted, as a fresh process would. */
export function resetShownCredentialsForTests(): void {
  newestShown = -Infinity;
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

/** The route list on a dashboard: which plan it is for, which of the
 * screen's loads put it there, by the order they started in, the list
 * itself, and whether the server answered with it or it came from the
 * cache. */
export interface ShownRoutes {
  plan: string | null;
  load: number;
  routes: RouteOption[];
  answered: boolean;
}

/** A dashboard's route list before any load has put one there. */
export const NO_ROUTES_SHOWN: ShownRoutes = { plan: null, load: 0, routes: [], answered: false };

/** Whether a load whose route request was answered puts that list on
 * screen: unless a later load has already put one there that the server
 * answered with.
 *
 * Every answered list used to go on screen. A mount's load whose route
 * request was slow -- twenty seconds an address now -- answered after the
 * load a server switch had started, and its list from before the switch
 * replaced the newer one. A list a later load put there from the cache is
 * replaced: an answer is newer than anything cached. */
export function takesRouteList(shown: ShownRoutes, load: number): boolean {
  return !(shown.answered && shown.load > load);
}

/** The route list a load whose route request failed writes into the
 * snapshot, beside its fresh credentials: what is on screen for this plan.
 * `standIn` is what `standInRoutes` put on screen, or null for nothing.
 *
 * It wrote the cached list, which is not always what the screen held: with
 * the screen keeping this plan's list from an earlier load and nothing
 * readable cached for it -- the earlier load's write failed, or had not
 * landed -- the snapshot was written with no servers, and the next start
 * with Neoxify out of reach opened the picker on none. */
export function routesForSnapshot(
  standIn: RouteOption[] | null,
  shown: ShownRoutes,
  plan: string,
  cached: RouteOption[],
): RouteOption[] {
  if (standIn !== null) return standIn;
  return shown.plan === plan ? shown.routes : cached;
}

/** Whether a load may write the snapshot: unless a later one has written
 * it already. `newestWriter` is the latest load that has.
 *
 * Asked of which load last *wrote*, not which last put a list on screen. A
 * load that fell back to the cache writes nothing, and an earlier load
 * whose credentials were fresh, overtaken by such a load, used to be kept
 * from writing them at all, so the next offline start had older ones. */
export function maySaveSnapshot(newestWriter: number, load: number): boolean {
  return load >= newestWriter;
}

/** What a dashboard's load whose route request failed puts on screen, or
 * null to leave the list there as it is. `cached` is the list cached for
 * this plan (`cachedRoutesFor`); `load` is this load's place in the order.
 *
 *  - A later load has put its own list on screen meanwhile: null. Its list
 *    is newer than anything this one could find in the cache, which may
 *    not yet hold it -- it is written without waiting.
 *  - This plan's list, already on screen: null, and it stays. An earlier
 *    load of this screen put it there, and it is at least as new as the
 *    cache, which may not hold it yet: the cached list used to replace it,
 *    and an older one went on screen, and into the snapshot, over it.
 *  - A list cached for this plan: that.
 *  - Nothing cached for it: the list on screen stays if it is this plan's,
 *    and goes if it is another's. A failed request never blanks a list
 *    the customer can use, but one for another plan cannot be used:
 *    picked from, it switches to a route the plan does not have, which the
 *    server refuses. The phone's picker opens on the dashboard's list now,
 *    as the desktop's does, and would have offered it. */
export function standInRoutes(cached: RouteOption[], shown: ShownRoutes, plan: string, load: number): RouteOption[] | null {
  if (shown.load > load) return null;
  if (shown.plan === plan && shown.routes.length > 0) return null;
  if (cached.length > 0) return cached;
  return shown.plan === plan ? null : [];
}

/** Replaces just the route list, for the subscription the snapshot holds:
 * a list the server list's own request was answered with
 * (`LocationPicker`'s `onRoutes`). Nothing for a snapshot of another
 * subscription or plan, whose servers these are not (`cachedRoutesFor`),
 * nor where nothing is cached. `stillCurrent` is `saveSnapshot`'s.
 *
 * The snapshot keeps the time it had. A route list is not an answer about
 * the credentials or the plan beside it, and the time is what says how
 * fresh those are. Written as now, a three-day-old snapshot counted as
 * fresh for ten minutes after the picker's list came in: Connect and the
 * refresh on resume asked nothing (`refreshConnectionConfig` in
 * connection-config.ts) and dialled credentials whose server had changed
 * its REALITY SNI since; with the app left open, every list that came in
 * put the refresh off again; and the next offline start's banner said the
 * plan's usage and expiry had been updated just now. */
export async function updateSnapshotRoutes(
  subscription: Pick<Subscription, "id" | "planId">,
  routes: RouteOption[],
  stillCurrent?: () => boolean,
): Promise<"written" | "skipped"> {
  const existing = await loadSnapshot();
  const held = existing?.subscription;
  if (!existing || !held || planOf(held) !== planOf(subscription)) return "skipped";
  await saveSnapshot(
    {
      subscription: existing.subscription,
      protocolUsers: existing.protocolUsers,
      routes,
      savedAt: existing.savedAt,
      ...(existing.askedAt !== undefined ? { askedAt: existing.askedAt } : {}),
    },
    stillCurrent,
  );
  return "written";
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
