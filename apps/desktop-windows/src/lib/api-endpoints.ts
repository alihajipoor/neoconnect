import { load, type Store } from "@tauri-apps/plugin-store";
import { API_BASE_URLS } from "./config";
import { loadSnapshot } from "./credential-cache";
import { bundledBases } from "./endpoint-bundle-store";

/** Where to reach the control plane, in the order worth trying.
 *
 * One hardcoded address was a single point of failure for the entire
 * product, and it failed: the panel's IP was filtered in Iran and every
 * customer there lost sign-in, purchase, support and updates at once --
 * on nodes that were not blocked at all.
 *
 * The fix is the same shape as protocol failover: a list, tried in
 * order, with the winner remembered per network. What makes it work
 * rather than just doubling the odds is where the alternatives come
 * from -- the customer's own nodes.
 *
 * Every VPN node already runs nginx behind its Xray TLS inbound, serving
 * the fallback site that non-VPN traffic gets. Adding one `location
 * /api/` there turns each node into an API mirror on a port it already
 * listens on, with a certificate it already has. The set of reachable
 * API endpoints then equals the set of reachable VPN nodes -- and if
 * every node is blocked there is no product to serve anyway, so the
 * control plane stops being an *extra* thing that can fail.
 *
 * The mirror addresses need no configuration and no new release to
 * change: they are derived from the credentials the app already holds.
 */

/** Remembered separately from the credential cache: which endpoint works
 * is a property of the network the device is on, not of the account. */
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load("api-endpoints.json", { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

const KEY = "lastGood";

/** An Xray TLS inbound answers anything that is not a valid VPN
 * connection with its fallback site, so an ordinary HTTPS request to the
 * same port and name reaches nginx behind it.
 *
 * Only TLS-secured Xray credentials qualify. REALITY deliberately proxies
 * unrecognised clients to the third-party site it is imitating, so a
 * request there reaches someone else's server, not ours -- which is the
 * entire point of REALITY and exactly why it cannot host a mirror.
 */
export function mirrorsFrom(
  users: { protocol: string; connection?: { port: number; security?: string; publicParams?: Record<string, unknown> } }[],
): string[] {
  const seen = new Set<string>();
  for (const user of users) {
    const connection = user.connection;
    if (!connection || connection.security !== "TLS") continue;
    const serverName = connection.publicParams?.serverName;
    // The name has to match the certificate; the node's bare IP does not,
    // and would fail the TLS handshake before reaching nginx.
    if (typeof serverName !== "string" || serverName.length === 0) continue;
    seen.add(`https://${serverName}:${connection.port}/api`);
  }
  return [...seen];
}

/** The endpoints to try, best first.
 *
 * Deliberately not deduplicated against the primary by hostname alone --
 * a node mirror on the same domain but a different port is a genuinely
 * different path to the same service, and on a network where one is
 * blocked the other may not be.
 */
export async function apiEndpoints(): Promise<string[]> {
  const ordered: string[] = [];
  const add = (url: string) => {
    if (url && !ordered.includes(url)) ordered.push(url);
  };

  // Whatever worked last time leads. On a filtered network that is the
  // difference between connecting immediately and waiting out a timeout
  // against the blocked address on every single request.
  //
  // This process's own memory first, as `rememberedEndpoint` reads it. The
  // store's copy is written asynchronously, and a race that started before
  // the write had landed was led by the address the race before had just
  // found dead, and waited out its head start on it again.
  if (rememberedHere !== undefined) add(rememberedHere);
  else {
    try {
      const store = await getStore();
      const remembered = await store.get<string>(KEY);
      if (typeof remembered === "string" && remembered !== forgottenHere) add(remembered);
    } catch {
      // No memory is not an error; the list below still works.
    }
  }

  // The signed bundle before the compiled-in list: the binary's idea of
  // where to find us is fixed at build time and cannot be corrected for
  // a customer who cannot reach us to be updated, which is exactly the
  // customer this ordering is for. The compiled list stays underneath as
  // the floor for a client that has never successfully fetched one.
  try {
    for (const base of await bundledBases()) add(base);
  } catch {
    // A missing or unreadable bundle is the ordinary state on a fresh
    // install and must never stop the rest of the list being tried.
  }

  for (const base of API_BASE_URLS) add(base);

  try {
    const snapshot = await loadSnapshot();
    if (snapshot) for (const mirror of mirrorsFrom(snapshot.protocolUsers)) add(mirror);
  } catch {
    // A missing or unreadable cache costs the mirrors, not the primary.
  }

  return ordered;
}

/** The endpoint this process last remembered, held here as well as in
 * the store. The store's copy is written asynchronously, and a walk that
 * reads it again between steps (`rememberedEndpoint`) must not miss an
 * address another request found a moment earlier. */
let rememberedHere: string | undefined;

/** The endpoint this process last forgot (`forgetEndpoint`), so that the
 * store's copy, deleted asynchronously, does not bring it back first. */
let forgottenHere: string | undefined;

/** The endpoint that answered most recently, if one is known.
 *
 * Read by a write that is walking addresses one at a time, before each
 * step. The walk's own list was fixed when it began; another request may
 * since have found an address that answers. Never throws: not knowing
 * costs the walk a shortcut, not the request. */
export async function rememberedEndpoint(): Promise<string | undefined> {
  if (rememberedHere !== undefined) return rememberedHere;
  try {
    const store = await getStore();
    const remembered = await store.get<string>(KEY);
    return typeof remembered === "string" && remembered.length > 0 ? remembered : undefined;
  } catch {
    return undefined;
  }
}

/** Records the endpoint that answered.
 *
 * Only ever called on a real response -- including an error response,
 * since a 401 proves the endpoint is reachable and doing its job. What
 * must not be remembered is an endpoint that merely failed slowly.
 */
export async function rememberEndpoint(url: string): Promise<void> {
  rememberedHere = url;
  if (forgottenHere === url) forgottenHere = undefined;
  try {
    const store = await getStore();
    await store.set(KEY, url);
    await store.save();
  } catch {
    // Costs a little time on the next launch, nothing else.
  }
}

/** Forgets `url` as the endpoint to try first, if it is the one held.
 *
 * For an address found not to be the backend after it was remembered: one
 * that answers JSON 401 to everything, the public health check included,
 * wins a read with its fast 401 before anything shows it is not us. Kept,
 * it led every race on every launch. Nothing else is remembered in its
 * place: the next address to answer is. */
export async function forgetEndpoint(url: string): Promise<void> {
  if (rememberedHere === url) rememberedHere = undefined;
  forgottenHere = url;
  try {
    const store = await getStore();
    if ((await store.get<string>(KEY)) !== url) return;
    await store.delete(KEY);
    await store.save();
  } catch {
    // The address leads the next race, which it no longer wins.
  }
}
