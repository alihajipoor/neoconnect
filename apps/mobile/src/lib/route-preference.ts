import { load, type Store } from "@tauri-apps/plugin-store";

/*
The server the customer last chose, remembered between launches.

It was not remembered before. `chosenRouteId` lived in React state and
was set only by the location picker, so every restart put the customer
back on whichever route the ladder preferred -- someone who had
deliberately picked Finland got France again the next morning, silently,
with the picker showing the new choice as though they had made it.

That matters more here than it looks. The whole point of pinning a route
is that the customer found one that works on their network, which for
the audience this product exists for may be the only one that does.
Making them rediscover it on every launch throws away the one piece of
knowledge they had.

The desktop client has always persisted this. This is the mobile half
catching up, deliberately using the same store mechanism per-app.ts
already uses rather than introducing a second one.
*/

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // A rejected promise must not be cached, or one transient failure
  // breaks saving for the life of the process.
  storePromise ??= load("route-preference.json", { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

const KEY = "chosenRouteId";

/** The remembered route, or null if the customer has never picked one.
 *
 * Never throws. A route preference is a convenience, and failing to read
 * it must not stop the dashboard rendering -- the ladder's own ordering
 * is a perfectly good fallback.
 */
export async function loadChosenRoute(): Promise<string | null> {
  try {
    const store = await getStore();
    const stored = await store.get<string>(KEY);
    return typeof stored === "string" && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** Remembers the customer's choice, or forgets it when passed null.
 *
 * Best-effort for the same reason as the read: a failed write should
 * cost the customer their preference next launch, not their connection
 * now.
 */
export async function saveChosenRoute(routeId: string | null): Promise<void> {
  try {
    const store = await getStore();
    if (routeId) {
      await store.set(KEY, routeId);
    } else {
      await store.delete(KEY);
    }
    await store.save();
  } catch {
    // Deliberately swallowed -- see the note above.
  }
}
