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
