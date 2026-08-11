import { load, type Store } from "@tauri-apps/plugin-store";
import type { LastGoodMap } from "./failover";

// Which protocol last carried real traffic on each network, persisted so
// the answer survives a restart -- a memory that resets every launch
// would make the customer pay the discovery cost over and over, which is
// the delay it exists to remove.
//
// Deliberately its own file rather than sharing session.json: this is a
// preference, not a credential, and clearing a session should not
// discard what the app has learned about the networks it has seen.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // Same reasoning as session.ts: a rejected promise must not be cached,
  // or one transient failure permanently breaks saving for the life of
  // the process.
  storePromise ??= load("failover.json", { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

const KEY = "lastGood";

/** Everything learned so far, or an empty map.
 *
 * An unreadable store means "nothing learned yet", never an error: the
 * consequence is one slower connect, and failing the whole screen over a
 * lost preference would be wildly out of proportion.
 */
export async function loadLastGood(): Promise<LastGoodMap> {
  try {
    const store = await getStore();
    return (await store.get<LastGoodMap>(KEY)) ?? {};
  } catch {
    return {};
  }
}

/** Best-effort. A preference that fails to persist costs the next
 * connect a few seconds; it must never surface to the customer. */
export async function saveLastGood(map: LastGoodMap): Promise<void> {
  try {
    const store = await getStore();
    await store.set(KEY, map);
    await store.save();
  } catch {
    // Intentionally silent -- see above.
  }
}

const CHOSEN_KEY = "chosenRoute";

/* The server the customer picked on purpose.
 *
 * Held only in React state until now, so it died with the process while
 * the *displayed* server -- read from the cached provisioned route --
 * survived. The two then disagreed silently: the dashboard said
 * sg-singapore, the ladder had no pin, speed-first ordering put
 * WireGuard at the head, and the connection came up in France with no
 * notice, because from the ladder's point of view nothing had failed
 * over. Observed exactly that on a clean install after signing out and
 * back in.
 *
 * Persisting it is what makes the screen and the behaviour agree, and
 * it restores the M23 promise that a deliberate choice is not quietly
 * overridden -- which had been true only until the app was restarted.
 *
 * Same store as the network memory above: both are preferences, neither
 * is a credential, and both should outlive a session being cleared. */
export async function loadChosenRoute(): Promise<string | null> {
  try {
    const store = await getStore();
    return (await store.get<string>(CHOSEN_KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function saveChosenRoute(routeId: string | null): Promise<void> {
  try {
    const store = await getStore();
    if (routeId) await store.set(CHOSEN_KEY, routeId);
    else await store.delete(CHOSEN_KEY);
    await store.save();
  } catch {
    // Intentionally silent -- see above.
  }
}
