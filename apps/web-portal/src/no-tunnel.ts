import { setTunnelTeardown } from "@shared/lib/session-end";
import type { TeardownVerdict } from "@shared/lib/tunnel-teardown";

/**
 * How the portal ends a session's tunnel: there is none to end.
 *
 * endCustomerSession() takes the platform's tunnel down before it clears
 * the tokens, and its default is the desktop service's. In a browser every
 * invoke() of that throws (src/shims/misc.ts), so the status it polls is
 * never "down" and it waited out its whole 10 s budget -- on every
 * sign-out, account deletion and refused refresh -- with the session
 * still in localStorage and the Sign out button showing nothing. A
 * customer on a shared computer who closed the tab in that window left
 * themselves signed in for the next person.
 *
 * "down" is true here by construction rather than by asking: this page
 * cannot start a tunnel, since every native call it could make throws.
 * It says nothing about a Neoxify app on the same machine, and no portal
 * screen shows the verdict. The apps install their own (mobile: App.tsx).
 */
export async function noTunnelHere(): Promise<TeardownVerdict> {
  return "down";
}

setTunnelTeardown(noTunnelHere);
