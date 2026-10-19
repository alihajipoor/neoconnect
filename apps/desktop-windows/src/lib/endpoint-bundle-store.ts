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
/** The newest offline-signed list held, apart from the list in force.
 *
 * A server list stops verifying when its statement runs out, or when the
 * device's clock runs ahead of it; an offline list never does. With one
 * slot, a server list replaced the offline list it superseded, and once
 * it stopped verifying the client went back to the seed it was built with
 * -- whose hosts may be the very ones blocked since, leaving it nowhere to
 * fetch a new list from. Kept whenever a newer genuine one is fetched,
 * even beneath a server list, so that the fallback is the newest offline
 * list instead. */
const OFFLINE_KEY = "offline";
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
 * than none. A server list is the one exception, and not by this file's
 * choice: it stops verifying when its statement runs out, and the newest
 * offline list held takes its place (`OFFLINE_KEY`).
 */
export async function cachedBundle(): Promise<EndpointBundle | null> {
  const seedRaw = JSON.stringify(seedEnvelope);
  const seed = await seedBundle(seedRaw);
  // The offline list kept apart is read only when the stored one does not
  // verify: every list it takes is stored as the list in force too, unless
  // that already held a newer one, so a stored list that verifies is at
  // least as new.
  const stored = (await storedList(KEY)) ?? (await storedList(OFFLINE_KEY));
  // The newer of the two, not simply the stored one. An install that has
  // never reached us has no stored bundle and would otherwise fall
  // through to the compiled-in bases, every one of which is on the
  // censored domain -- which is precisely the customer this exists for.
  // And after an upgrade the shipped seed can legitimately be the fresher
  // list, so version order decides rather than provenance.
  const useSeed = !stored || (seed !== null && isNewer(seed, stored.bundle));
  const inForce = useSeed ? (seed ? { bundle: seed, raw: seedRaw } : null) : stored;
  // Before any request reaches for the list's hosts: a list adopted in an
  // earlier run names hosts this run's scope does not know yet.
  if (inForce) await grantScope(inForce.raw);
  return inForce?.bundle ?? null;
}

/** The genuine list stored under `key`, with its envelope, or null.
 *
 * Re-verified on every read rather than trusted because we wrote it: the
 * file sits on a disk other software can reach, and the signature costs a
 * millisecond. */
async function storedList(key: string): Promise<{ bundle: EndpointBundle; raw: string } | null> {
  try {
    const store = await getStore();
    const raw = await store.get<string>(key);
    if (typeof raw !== "string") return null;
    const bundle = await verifyBundle(raw);
    return bundle ? { bundle, raw } : null;
  } catch {
    return null;
  }
}

/** The bundle compiled into this build, or null if it is the placeholder. */
async function seedBundle(raw: string): Promise<EndpointBundle | null> {
  try {
    return await verifyBundle(raw);
  } catch {
    return null;
  }
}

async function persist(key: string, raw: string): Promise<void> {
  const store = await getStore();
  await store.set(key, raw);
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
 * offline one (`SERVER_BUNDLE_PATH`). The offline one is also kept apart
 * whenever it is the newest offline list seen (`OFFLINE_KEY`).
 *
 * Returns the bundle now in force, which may be the one already held.
 * Never throws: this runs alongside real work and a failure here must
 * never be the reason a request did not happen.
 *
 * One at a time (`refreshing`).
 */
export function refreshFrom(base: string, fetcher: Fetcher): Promise<EndpointBundle | null> {
  const turn = refreshing.then(() => refreshOnce(base, fetcher));
  refreshing = turn.catch(() => undefined);
  return turn;
}

/** The refresh under way, which the next one waits for.
 *
 * Two can be asked for at once: the relay's, whose calls queue behind
 * other relay calls at up to twelve seconds each, and the ordinary one,
 * when an ordinary address answers meanwhile. Each compares what it
 * fetches with the lists held when it began, so side by side the later to
 * finish stored a genuine but older list over the newer one the other had
 * just adopted -- in either slot, and exactly the walk-back `isNewer`
 * exists to refuse. One after the other, each begins from what the last
 * one stored. */
let refreshing: Promise<unknown> = Promise.resolve();

async function refreshOnce(base: string, fetcher: Fetcher): Promise<EndpointBundle | null> {
  let held = await cachedBundle();
  let offline = (await storedList(OFFLINE_KEY))?.bundle ?? null;
  for (const path of [SERVER_BUNDLE_PATH, BUNDLE_PATH]) {
    const fresh = await fetchVerified(`${base}${path}`, fetcher);
    if (!fresh) continue;
    if (isNewer(fresh.bundle, held)) {
      try {
        await persist(KEY, fresh.raw);
      } catch {
        // Not adopted: every reader takes the list from the store, which
        // still holds the old one. The next run fetches it again -- and
        // the offline slot waits for it too, so the list in force stays
        // the newer of the two (`cachedBundle`).
        continue;
      }
      await grantScope(fresh.raw);
      held = fresh.bundle;
    }
    // Kept apart even when it is not newer than the list in force: it is
    // what a server list falls back to once it stops verifying
    // (`OFFLINE_KEY`).
    if (fresh.bundle.offline === true && isNewer(fresh.bundle, offline)) {
      try {
        await persist(OFFLINE_KEY, fresh.raw);
        offline = fresh.bundle;
      } catch {
        // Kept at the next refresh, which fetches it again.
      }
    }
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

/** Refreshes the bundle through the relay of last resort, once a run, for
 * a client no ordinary address has answered. last-resort.ts asks as the
 * backend answers there, and `fetcher` sends each path through the relay
 * as a background call -- under the Settings switch, the region refusal,
 * the tunnel's gate and the budget, like any other.
 *
 * Without it the lists reached only clients an ordinary address answered
 * (`maybeRefreshBundle`). A client the relay alone reaches -- every
 * ordinary address blocked, the case on 2026-10-17 -- never learnt a new
 * domain, a bare IP or a relay box rotated through the list, though those
 * are the clients the list is for.
 *
 * Not once the ordinary refresh has run: that address has been asked
 * already, at no cost to the relay's budget. `fetcher` takes the path
 * alone, as the relay does, so the base is empty. */
let relayRefreshAttempted = false;
export async function maybeRefreshBundleThroughRelay(fetcher: Fetcher): Promise<void> {
  if (refreshAttempted || relayRefreshAttempted) return;
  relayRefreshAttempted = true;
  try {
    await refreshFrom("", fetcher);
  } catch {
    // As `maybeRefreshBundle`: the held list still works.
  }
}

/** Test seam: the once-per-run guards are module state. */
export function resetBundleRefreshForTests(): void {
  refreshAttempted = false;
  relayRefreshAttempted = false;
}
