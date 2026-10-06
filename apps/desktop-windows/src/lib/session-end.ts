import { clearGamingProfileCache } from "./customer";
import { clearSnapshot } from "./credential-cache";
import { deviceSlot, slotNoticeStore, slotTeardown } from "./device-slot-session";
import { clearTokens } from "./session";
import { tearDownForSignOut, type TeardownVerdict } from "./tunnel-teardown";

/** How this platform takes its tunnel down when a session ends.
 *
 * The desktop service by default, which is what Windows and macOS both
 * reach through the shared UI. The mobile app replaces it at startup:
 * its tunnel is a VpnService or a NetworkExtension profile, the
 * confirmation is a different question there (`vpn_tunnel_gone`), and
 * the profile the platform keeps has to be forgotten as well as stopped.
 */
let tunnelTeardown: () => Promise<TeardownVerdict> = () => tearDownForSignOut();

export function setTunnelTeardown(teardown: () => Promise<TeardownVerdict>): void {
  tunnelTeardown = teardown;
}

/** Bumped every time a session ends.
 *
 * A connect ladder captures it before it starts and checks it after
 * every engine it brings up. Without that, a sign-out pressed while a
 * connect was still walking its protocols tore down whatever was up at
 * that moment -- and the ladder, still running in an unmounted screen,
 * brought the next protocol up a second later under no account at all.
 */
let generation = 0;

export function sessionGeneration(): number {
  return generation;
}

export type SessionEnd = { tunnel: TeardownVerdict };

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
 * And none of the three took the tunnel down. Signing out drew the
 * sign-in screen over a live tunnel that nothing on that screen could
 * disconnect, and the Windows service only ends a tunnel when the app
 * process goes -- which signing out does not do. So the tunnel comes
 * down here, first, and the credentials only after it: the session is
 * not over while traffic is still leaving under it. A teardown that
 * could not be confirmed does not stop the sign-out (the customer asked
 * to leave, and keeping their credentials would not make the tunnel any
 * less up); it is returned, so the caller can say so instead of showing
 * a sign-in screen that implies the device is inert.
 *
 * Idempotent, and safe to call on a path that has already cleared the
 * tokens -- every step is a delete, and a second teardown finds nothing
 * up and answers at once.
 *
 * Deliberately not exhaustive over on-disk state. `split-tunnel.json`,
 * `gaming.json` and `failover.json` also survive a sign-out, and each of
 * the three says in its own header that this is intended: they are the
 * customer's own configuration of *this machine*, not the previous
 * account's secrets, and wiping them on sign-out would silently discard
 * a selection somebody built by hand. That reasoning does not extend to
 * credentials or entitlement, which is the line drawn here.
 */
export async function endCustomerSession(): Promise<SessionEnd> {
  // Synchronous and first, both of them: they are the state that lives
  // in this process's memory rather than in a file, so nothing can await
  // in front of them and read the old value. The generation in
  // particular has to move before the teardown starts, or a ladder that
  // checks it during the teardown would still see its session as live.
  generation += 1;
  clearGamingProfileCache();
  // Forgotten, not released: signing out releases this device's slot on
  // the server by itself (docs/device-slots.md, obligation 8), and a
  // renewal still owed to the old session must not land on the next.
  deviceSlot.reset();
  // Its card too: it names the old account's devices, and the next
  // account to sign in on this machine must not open onto it.
  slotNoticeStore.set(null);
  // And any teardown it still owed: the sign-out's own, below, takes the
  // tunnel down, and its retries must not run on into the next account.
  slotTeardown.clear();
  let tunnel: TeardownVerdict;
  try {
    tunnel = await tunnelTeardown();
  } catch {
    tunnel = "unconfirmed";
  }
  await clearTokens();
  await clearSnapshot();
  return { tunnel };
}
