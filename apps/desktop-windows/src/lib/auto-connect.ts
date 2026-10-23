/** "Connect when Neoxify starts": whether the app connects on its own when
 * it opens, and the once-per-run latch that keeps it to that.
 *
 * It is the customer's own Connect, pressed for them once: the same pass,
 * the same location (the one on the main page -- the pin, or Automatic),
 * the same evidence before anything says "protected", and the same
 * device-limit claim -- which never takes the slot from another device
 * (no takeover is ever passed), so a plan in use elsewhere shows its card
 * as a press would. It does nothing the customer would not see: the
 * screen says it is connecting, and why (`dash.autoConnecting`).
 *
 * When Neoxify starts, and only then:
 *  - once per run of the app, at the first main page of a run that
 *    started signed in (`autoConnectLatch`): not on every return from
 *    Settings, and not when somebody signs in later in the same run;
 *  - only over nothing: a tunnel the service kept up is adopted, never
 *    dialled again, and a state the service could not tell is not a
 *    "disconnected" to act on;
 *  - never in Gaming mode, which has no tunnel to bring up;
 *  - never past a press: an episode or a pass already running owns the
 *    tunnel.
 *
 * Phones decide the same way once their main page is bound to it; a phone
 * that still owes its VPN disclosure is never connected by this. Android's
 * Always-on VPN is not this: the tunnel service there stops itself when
 * the system starts it, so "on start" means the app's start. */

import type { ConnectionState } from "../components/ConnectOrb";

export type AutoConnectSkip =
  /** The setting is off. */
  | "off"
  /** Gaming mode is what the app was left in. */
  | "gaming"
  /** Something is up, being torn down, or the service could not say. */
  | "notIdle"
  /** A pass or an automatic reconnect is already running. */
  | "busy"
  /** No credential to dial with. */
  | "nothingToDial"
  /** The plan does not entitle this device to connect. */
  | "notEntitled"
  /** The plan's device limit has already said something this run. */
  | "deviceLimit"
  /** A phone's VPN disclosure has not been accepted. */
  | "disclosure";

export interface AutoConnectInput {
  readonly enabled: boolean;
  readonly mode: "vpn" | "gaming";
  /** What the screen shows from the service's answer at load. */
  readonly state: ConnectionState;
  readonly passRunning: boolean;
  readonly reconnecting: boolean;
  readonly hasCredential: boolean;
  /** The subscription's status, when one is known; undefined when the
   * screen has none to read (offline, nothing cached). */
  readonly subscriptionStatus: string | undefined;
  readonly deviceLimitNotice: boolean;
  /** Phones only; Windows has no disclosure to accept. */
  readonly disclosureAccepted?: boolean;
}

export type AutoConnectDecision = { readonly go: true } | { readonly go: false; readonly why: AutoConnectSkip };

export function autoConnectDecision(input: AutoConnectInput): AutoConnectDecision {
  const skip = (why: AutoConnectSkip): AutoConnectDecision => ({ go: false, why });
  if (!input.enabled) return skip("off");
  if (input.disclosureAccepted === false) return skip("disclosure");
  if (input.mode === "gaming") return skip("gaming");
  if (input.passRunning || input.reconnecting) return skip("busy");
  if (input.state !== "disconnected") return skip("notIdle");
  if (!input.hasCredential) return skip("nothingToDial");
  if (input.subscriptionStatus !== undefined && input.subscriptionStatus !== "ACTIVE") return skip("notEntitled");
  if (input.deviceLimitNotice) return skip("deviceLimit");
  return { go: true };
}

let armed = true;

/** One chance per run of the app. */
export const autoConnectLatch = {
  /** Whether this run's chance is still there. */
  armed(): boolean {
    return armed;
  },
  /** Takes it: true only the first time. */
  take(): boolean {
    if (!armed) return false;
    armed = false;
    return true;
  },
  /** This run did not open on the main page signed in -- it opened on
   * sign-in, or the session ended -- so nothing connects "on start". */
  disarm(): void {
    armed = false;
  },
  /** For tests: a fresh run. */
  resetForTests(): void {
    armed = true;
  },
};
