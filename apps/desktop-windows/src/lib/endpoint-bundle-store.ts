import { load, type Store } from "@tauri-apps/plugin-store";
import { isNewer, orderedBases, verifyBundle, type EndpointBundle } from "./endpoint-bundle";

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
  try {
    const store = await getStore();
    const raw = await store.get<string>(KEY);
    if (typeof raw !== "string") return null;
    // Re-verified on every read rather than trusted because we wrote it:
    // the file sits on a disk other software can reach, and the signature
    // costs a millisecond.
    return await verifyBundle(raw);
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
