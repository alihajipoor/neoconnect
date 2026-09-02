import { load, type Store } from "@tauri-apps/plugin-store";
import { isNewer, orderedBases, verifyBundle, type EndpointBundle } from "./endpoint-bundle";
// Written at build time by scripts/ensure-seed-bundle.mjs. In the repo
// this is the inert placeholder, so a checkout carries no addresses.
import seedEnvelope from "./seed-bundle.json";

/** Where the signed list is kept between runs.
 *
 * Separate file from `api-endpoints.json`, which remembers *which* base
 * last worked on this network. That is a property of the network; this
 * is a property of the deployment, and conflating them would make a
 * café's captive portal look like a reason to distrust the operator's
 * address list.
 */
const FILE = "endpoint-bundle.json";
const KEY = "bundle";
/** The path the bundle is served on, relative to any API base. Every
 * endpoint in the bundle can serve the next bundle, which is what makes
 * the list self-healing: reach one, learn all. */
export const BUNDLE_PATH = "/endpoints/bundle";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(FILE, { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

/** The cached bundle, or null.
 *
 * Never expires, deliberately, and for the same reason `credential-cache`
 * refuses to: a customer whose control plane is filtered must still be
 * able to connect, and a list that expired itself would reintroduce the
 * outage it exists to prevent. An old address list is worth far more
 * than none.
 */
export async function cachedBundle(): Promise<EndpointBundle | null> {
  const seed = await seedBundle();
  let stored: EndpointBundle | null = null;
  try {
    const store = await getStore();
    const raw = await store.get<string>(KEY);
    // Re-verified on every read rather than trusted because we wrote it:
    // the file sits on a disk other software can reach, and the signature
    // costs a millisecond.
    if (typeof raw === "string") stored = await verifyBundle(raw);
  } catch {
    stored = null;
  }
  // The newer of the two, not simply the stored one. An install that has
  // never reached us has no stored bundle and would otherwise fall
  // through to the compiled-in bases, every one of which is on the
  // censored domain -- which is precisely the customer this exists for.
  // And after an upgrade the shipped seed can legitimately be the fresher
  // list, so version order decides rather than provenance.
  if (!stored) return seed;
  if (seed && isNewer(seed, stored)) return seed;
  return stored;
}

/** The bundle compiled into this build, or null if it is the placeholder. */
async function seedBundle(): Promise<EndpointBundle | null> {
  try {
    return await verifyBundle(JSON.stringify(seedEnvelope));
  } catch {
    return null;
  }
}

async function persist(raw: string): Promise<void> {
  const store = await getStore();
  await store.set(KEY, raw);
  await store.save();
}

/** Fetches a bundle from `base`, and adopts it if it is genuine and newer.
 *
 * Returns the bundle now in force, which may be the one already held.
 * Never throws: this runs alongside real work and a failure here must
 * never be the reason a request did not happen.
 */
export async function refreshFrom(
  base: string,
  fetcher: (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>,
): Promise<EndpointBundle | null> {
  const held = await cachedBundle();
  try {
    const response = await fetcher(`${base}${BUNDLE_PATH}`);
    // A 404 is the ordinary answer before anything has been published.
    if (!response.ok) return held;
    const raw = await response.text();
    const fresh = await verifyBundle(raw);
    if (!fresh) return held;
    if (!isNewer(fresh, held)) return held;
    await persist(raw);
    return fresh;
  } catch {
    return held;
  }
}

/** Bases from the cached bundle, in the order to try. */
export async function bundledBases(preferRegion?: string): Promise<string[]> {
  const bundle = await cachedBundle();
  return bundle ? orderedBases(bundle, preferRegion) : [];
}

/** Iran's DNS block page. A name resolving here is not slow or broken --
 * it is censored, definitively, and the eight seconds an ordinary
 * failover spends discovering that is eight seconds per blocked entry on
 * the first request of every session.
 *
 * Matching the /24 rather than the two addresses seen in the wild:
 * 10.10.34.34 and .35 both appeared today, on the same network, for
 * different names. */
export function isKnownBlockPage(address: string): boolean {
  return /^10\.10\.34\./.test(address);
}

/** Refreshes the bundle from an endpoint that just answered, once a run.
 *
 * Called after a successful request rather than on a timer: an endpoint
 * that has just served a response is known-reachable right now, which is
 * the only moment a refresh is certain to be worth attempting. Without
 * this the published list reached nobody -- the mechanism existed and was
 * never triggered.
 *
 * Guarded to once per run because every request would otherwise re-fetch
 * an address list that changes a few times a year.
 */
let refreshAttempted = false;
export async function maybeRefreshBundle(base: string): Promise<void> {
  if (refreshAttempted) return;
  refreshAttempted = true;
  // refreshFrom never throws; this is belt and braces for the fetch
  // reference itself being unavailable in an odd host.
  try {
    await refreshFrom(base, (url) => fetch(url));
  } catch {
    // A refresh that did not happen costs nothing today: the held list
    // still works, which is the entire premise of caching it forever.
  }
}

/** Test seam: the once-per-run guard is module state. */
export function resetBundleRefreshForTests(): void {
  refreshAttempted = false;
}
