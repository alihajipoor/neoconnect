import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { isNewer, orderedBases, verifyBundle, type EndpointBundle, type LastResortEntry } from "./endpoint-bundle";
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
/** The list the server signs itself, under a compiled-in key's statement
 * (`ServerKeyStatement` in endpoint-bundle.ts). Asked for first: it
 * follows the servers as they change, where the offline list waits for
 * the owner. Kept on its own path because a client from before the
 * statement existed refuses such a list, and must still be served the
 * offline one at `BUNDLE_PATH`. A backend with none published answers
 * 404, and the offline list is asked for instead. */
export const SERVER_BUNDLE_PATH = "/endpoints/bundle2";

// ---------------------------------------------------------------------------
// The HTTP scope.

/** Asks the Rust side to let the HTTP plugin reach the hosts of a signed
 * list (src-tauri/src/bundle_scope.rs, `grant_bundle_scope`).
 *
 * The capability scope written at build time names only the hosts of the
 * seed list, so a newer list could only ever move clients between
 * addresses the build already knew: a new domain, or a bare IP, needed a
 * release -- undeliverable to exactly the customers the list is for. The
 * command checks the list's signature itself before it widens anything,
 * so nothing here can grant a host the owner did not sign. */
type ScopeGranter = (envelope: string) => Promise<unknown>;

let scopeGranter: ScopeGranter = (envelope) => invoke("grant_bundle_scope", { envelope });

/** The envelope last granted in this run: asking again for the same one
 * would add nothing. */
let grantedEnvelope: string | null = null;

/** Grants the scope for `raw`, once. Never throws: a build without the
 * command (the web portal, or the macOS app) keeps the scope it was built
 * with, and so does a list the command refuses. */
async function grantScope(raw: string): Promise<void> {
  if (raw === grantedEnvelope) return;
  try {
    await scopeGranter(raw);
    grantedEnvelope = raw;
  } catch {
    // Asked again with the next list, or at the next start.
  }
}

/** Test seam: the command, and what has been granted this run. */
export function setScopeGranterForTests(granter: ScopeGranter | null): void {
  scopeGranter = granter ?? ((envelope) => invoke("grant_bundle_scope", { envelope }));
  grantedEnvelope = null;
}

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
  const seedRaw = JSON.stringify(seedEnvelope);
  const seed = await seedBundle(seedRaw);
  let stored: EndpointBundle | null = null;
  let storedRaw: string | null = null;
  try {
    const store = await getStore();
    const raw = await store.get<string>(KEY);
    // Re-verified on every read rather than trusted because we wrote it:
    // the file sits on a disk other software can reach, and the signature
    // costs a millisecond.
    if (typeof raw === "string") {
      stored = await verifyBundle(raw);
      storedRaw = raw;
    }
  } catch {
    stored = null;
  }
  // The newer of the two, not simply the stored one. An install that has
  // never reached us has no stored bundle and would otherwise fall
  // through to the compiled-in bases, every one of which is on the
  // censored domain -- which is precisely the customer this exists for.
  // And after an upgrade the shipped seed can legitimately be the fresher
  // list, so version order decides rather than provenance.
  const useSeed = !stored || (seed !== null && isNewer(seed, stored));
  const inForce = useSeed ? seed : stored;
  // Before any request reaches for the list's hosts: a list adopted in an
  // earlier run names hosts this run's scope does not know yet.
  if (inForce) await grantScope(useSeed ? seedRaw : (storedRaw as string));
  return inForce;
}

/** The bundle compiled into this build, or null if it is the placeholder. */
async function seedBundle(raw: string): Promise<EndpointBundle | null> {
  try {
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

type Fetcher = (
  url: string,
) => Promise<{ ok: boolean; text: () => Promise<string>; body?: ReadableStream<Uint8Array> | null }>;

/** The genuine list at `url` with its envelope, or null. Never throws. */
async function fetchVerified(url: string, fetcher: Fetcher): Promise<{ bundle: EndpointBundle; raw: string } | null> {
  try {
    const response = await fetcher(url);
    // A 404 is the ordinary answer before anything has been published.
    //
    // Its body is let go of rather than left: under the HTTP plugin an
    // unread response stays parked on the Rust side, with its connection,
    // until it is read to the end or cancelled -- for the life of the app,
    // for a mirror that does not proxy this path.
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    const raw = await response.text();
    const bundle = await verifyBundle(raw);
    return bundle ? { bundle, raw } : null;
  } catch {
    return null;
  }
}

/** Fetches the lists from `base`, and adopts the newest if it is genuine
 * and newer than the one held: the server-signed list first, then the
 * offline one (`SERVER_BUNDLE_PATH`).
 *
 * Returns the bundle now in force, which may be the one already held.
 * Never throws: this runs alongside real work and a failure here must
 * never be the reason a request did not happen.
 */
export async function refreshFrom(base: string, fetcher: Fetcher): Promise<EndpointBundle | null> {
  let held = await cachedBundle();
  for (const path of [SERVER_BUNDLE_PATH, BUNDLE_PATH]) {
    const fresh = await fetchVerified(`${base}${path}`, fetcher);
    if (!fresh || !isNewer(fresh.bundle, held)) continue;
    try {
      await persist(fresh.raw);
    } catch {
      // Not adopted: every reader takes the list from the store, which
      // still holds the old one. The next run fetches it again.
      continue;
    }
    await grantScope(fresh.raw);
    held = fresh.bundle;
  }
  return held;
}

/** Bases from the cached bundle, in the order to try. */
export async function bundledBases(preferRegion?: string): Promise<string[]> {
  const bundle = await cachedBundle();
  return bundle ? orderedBases(bundle, preferRegion) : [];
}

/** The relay entries of the bundle in force, in the operator's order.
 *
 * For last-resort.ts alone. Never merged into `bundledBases`: a relay is
 * not a base any ordinary request is sent to (see `LastResortEntry`).
 * Never throws; no bundle, or none with a relay, is an empty list. */
export async function lastResortEntries(): Promise<LastResortEntry[]> {
  try {
    return (await cachedBundle())?.lastResort ?? [];
  } catch {
    return [];
  }
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
