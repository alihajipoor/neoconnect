import { invoke } from "@tauri-apps/api/core";
import { withTimeout } from "./service-call";

/** Taking the tunnel down because the customer's session is ending.
 *
 * Its own module, separate from the Dashboard's disconnect, for two
 * reasons. A session ends from places that have no Dashboard -- Settings'
 * account deletion, a token the server refused while some other screen
 * was up -- and every one of them must leave the machine with no tunnel.
 * And the answer has to be testable without a Tauri runtime, because
 * "it said it disconnected" is precisely the claim this project has been
 * caught making without evidence.
 *
 * Before this existed, signing out cleared the tokens and the cached
 * credentials and drew the sign-in screen over a tunnel that was still
 * up. Nothing on that screen can disconnect it. The Windows service only
 * tears a tunnel down when the app process goes away, and signing out
 * does not end the process -- so traffic kept leaving through the node
 * under an account the window no longer showed, for as long as the app
 * stayed open. On a shared machine the next person browsed on the
 * previous customer's subscription.
 */

/** What the teardown can honestly say. */
export type TeardownVerdict =
  /** The platform answered that nothing is connected. */
  | "down"
  /** It never said so inside the budget -- the tunnel may or may not be
   * up, and the customer has to be told that rather than reassured. */
  | "unconfirmed";

/** How long a sign-out waits for the tunnel to be reported gone.
 *
 * Longer than the Dashboard's own settle window, because nothing else
 * will come back to check: once the sign-in screen is up, this was the
 * only chance. Short enough that a service that never answers does not
 * hold somebody on "Signing out..." indefinitely -- they are told the
 * teardown was not confirmed instead. */
export const SIGN_OUT_TEARDOWN_MS = 10_000;

const POLL_MS = 250;

/** How often the disconnect is re-sent while the tunnel is still up.
 *
 * Re-sending is safe -- the service tears down whatever is there, and
 * there is nothing there twice -- and it covers a connect that was still
 * in flight when the first disconnect landed and finished after it. */
const RESEND_MS = 2_000;

export interface TeardownDeps {
  disconnect(): Promise<unknown>;
  /** Best effort: gaming mode's rules are not a tunnel, and a build with
   * no gaming mode (macOS) refuses the command outright. */
  disarmGaming(): Promise<unknown>;
  connected(): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The desktop service, as the shared UI reaches it on Windows and macOS.
 *
 * Every call bounded, for the reason service-call.ts gives: a pipe that
 * accepts and never answers would otherwise leave the sign-out waiting
 * for the life of the process. */
export const desktopTeardownDeps: TeardownDeps = {
  disconnect: () => withTimeout(invoke<void>("vpn_disconnect"), "vpn_disconnect"),
  disarmGaming: () => withTimeout(invoke<void>("gaming_disarm"), "gaming_disarm"),
  connected: () =>
    withTimeout(invoke<{ connected: boolean }>("vpn_status"), "vpn_status").then((s) => s.connected),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Disconnects, then waits for the platform to say nothing is connected.
 *
 * The verdict comes from asking, never from the disconnect having
 * returned: an acknowledged teardown is not a finished one, and a status
 * that could not be read is not a status that said "down". Both of those
 * shortcuts have produced false claims in this codebase before.
 */
export async function tearDownForSignOut(
  deps: TeardownDeps = desktopTeardownDeps,
  budgetMs: number = SIGN_OUT_TEARDOWN_MS,
): Promise<TeardownVerdict> {
  const deadline = deps.now() + budgetMs;

  // Its outcome is ignored on purpose: a disconnect that errored may
  // still have worked, and one that succeeded may not have finished. The
  // status below is what decides.
  await deps.disconnect().catch(() => undefined);
  let lastSent = deps.now();
  await deps.disarmGaming().catch(() => undefined);

  for (;;) {
    let connected: boolean | null;
    try {
      connected = await deps.connected();
    } catch {
      connected = null;
    }
    if (connected === false) return "down";
    if (deps.now() >= deadline) return "unconfirmed";
    if (connected === true && deps.now() - lastSent >= RESEND_MS) {
      await deps.disconnect().catch(() => undefined);
      lastSent = deps.now();
    }
    await deps.sleep(POLL_MS);
  }
}
