import { clearGamingProfileCache } from "./customer";
import { clearSnapshot } from "./credential-cache";
import { clearTokens } from "./session";

/** Everything that belongs to one signed-in customer, forgotten in one
 * place.
 *
 * This exists because the app has no auth context. Session state is a
 * screen name in `App.tsx` plus files on disk, so there was no single
 * moment that meant "this customer is done" and every teardown had to be
 * repeated by hand at each exit. There are three exits -- `logout()`,
 * `deleteAccount()`, and the 401 in `apiRequest` whose silent refresh
 * fails -- and before this, only one of them cleared anything beyond the
 * tokens:
 *
 *   - `clearGamingProfileCache()` was called from nowhere at all, so a
 *     customer's entitlement, their resolver's region and proxy address
 *     sat in module memory for 30 seconds past sign-out. Sign out, sign
 *     in as somebody else inside that window, and the second customer
 *     was shown the first one's answer. The ETag mixes in the customer
 *     id and so could never serve a wrong 304 -- the exposure was always
 *     the body already in memory, which no validator is consulted for.
 *
 *   - `clearSnapshot()` says in its own comment that it is "called on
 *     sign-out", and it was, from exactly one of the three exits.
 *     Deleting your account or having your session expire left the
 *     WireGuard private keys and the whole route list of the previous
 *     customer on the machine. `api-endpoints.ts` also steers requests
 *     using the node hostnames in that snapshot, so it outlived the
 *     session in a second way.
 *
 * Idempotent, and safe to call on a path that has already cleared the
 * tokens -- every step is a delete.
 *
 * Deliberately not exhaustive over on-disk state. `split-tunnel.json`,
 * `gaming.json` and `failover.json` also survive a sign-out, and each of
 * the three says in its own header that this is intended: they are the
 * customer's own configuration of *this machine*, not the previous
 * account's secrets, and wiping them on sign-out would silently discard
 * a selection somebody built by hand. That reasoning does not extend to
 * credentials or entitlement, which is the line drawn here.
 */
export async function endCustomerSession(): Promise<void> {
  // Synchronous and first: it is the one piece of state that lives in
  // this process's memory rather than in a file, so nothing can await
  // in front of it and read it.
  clearGamingProfileCache();
  await clearTokens();
  await clearSnapshot();
}
