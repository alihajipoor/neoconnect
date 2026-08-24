/** What the customer asked for, kept apart from what the app observed.
 *
 * The dashboard used to hold one variable, `connectionState`, and treat
 * it as both -- the phase on screen *and* the input the Connect button
 * branched on. Three asynchronous writers set it (the health poll, the
 * transient-state recheck, and the failover ladder), none of them
 * sequenced against the others, and the button then decided what a press
 * meant from whatever had landed last.
 *
 * That produced the report this module exists for: pressing Connect on
 * an idle app rendered "Disconnecting...", ran for a second or two, and
 * stopped -- three or four presses before one took. Two separate defects
 * behind it, both of which this file's types make unrepresentable:
 *
 *  1. A connect that failed narrated its own cleanup. The ladder tears
 *     down before reporting an outcome, and it published that teardown
 *     as "Disconnecting..." -- telling the customer the app was undoing
 *     the thing they had just asked it to do. `phaseFor` is the rule
 *     that a connect in progress is shown as connecting, whatever the
 *     service happens to be doing at that instant.
 *
 *  2. An answer fetched before a press could land after it and overwrite
 *     the state the press had just set, so the next press branched on an
 *     observation that had already been overtaken. `declareIntent` and
 *     `isCurrent` are how a late answer finds out it is late.
 *
 * Pure and React-free on purpose. A mechanism whose entire job is to be
 * correct under interleaving is a poor thing to take on faith, and the
 * dashboard cannot be exercised without a Tauri runtime.
 */

import type { ConnectionState } from "../components/ConnectOrb";
import type { TranslationKey } from "./i18n";

/** What the app is currently trying to do, as opposed to what it sees.
 *
 * `idle` is not "disconnected" -- it means no operation of ours is in
 * flight, so an observation from the service can be shown as it is.
 */
export type Intent = "idle" | "connect" | "disconnect";

/** What a press of the hero control does.
 *
 * Deliberately not derived at press time. It is computed in the same
 * render that computes the label, and handed to the handler with the
 * press, so the two cannot disagree: a button reading "Connect" carries
 * `connect` and nothing else can be substituted for it by an answer that
 * arrives in between.
 */
export type PressAction = "connect" | "cancelConnect" | "disconnect" | "recheck";

export interface IntentState {
  readonly intent: Intent;
  /** Bumped on every declaration, so an answer taken under an older one
   * can be recognised and dropped rather than published. */
  readonly generation: number;
}

export const IDLE_INTENT: IntentState = { intent: "idle", generation: 0 };

/** Records that the customer has asked for something new.
 *
 * Always advances the generation, including when the intent is unchanged
 * -- two consecutive connects are two operations, and an answer owed to
 * the first must not be allowed to describe the second.
 */
export function declareIntent(prev: IntentState, intent: Intent): IntentState {
  return { intent, generation: prev.generation + 1 };
}

/** Whether an answer fetched under `generation` still describes what the
 * app is doing. */
export function isCurrent(now: IntentState, generation: number): boolean {
  return now.generation === generation;
}

/** Marks the declared operation finished.
 *
 * Deliberately does *not* advance the generation. An operation ending is
 * not an operation being superseded: answers taken while it ran are
 * still the newest thing anyone knows, and dropping them would leave the
 * screen showing whatever preceded them. Only the wording rule changes
 * -- once nothing is in flight, an observation is shown as it is.
 *
 * A caller that no longer owns the stamp is ignored, because something
 * newer is running and only it may say when the app is idle.
 */
export function concludeIntent(prev: IntentState, generation: number): IntentState {
  if (prev.generation !== generation) return prev;
  return { intent: "idle", generation: prev.generation };
}

/** The phase to show for something the app observed, given what it is in
 * the middle of doing.
 *
 * The only rule, and it runs one way: while a connect the customer asked
 * for is still in progress, the screen does not report a teardown.
 *
 * There is always a real teardown inside a connect -- the ladder clears
 * whatever is up before it dials (a failed protocol's routes would
 * black-hole every probe for the next one), and the service does it
 * again in `connect_inner`, which begins with `self.disconnect()`. Both
 * are part of connecting. Neither is something the customer requested,
 * and showing "Disconnecting..." over them asserts they did.
 *
 * Everything else passes through untouched, and that includes `unknown`.
 * A connect in flight is not a reason to claim knowledge of a service
 * that will not answer: "Can't tell right now" outranks optimism here
 * exactly as it does everywhere else on this screen.
 */
export function phaseFor(intent: Intent, observed: ConnectionState): ConnectionState {
  if (intent !== "connect") return observed;
  if (observed === "disconnected" || observed === "disconnecting") return "connecting";
  return observed;
}

/** Label and action together, from one place, for every phase.
 *
 * Total over `ConnectionState` by type rather than by a chain of
 * ternaries with a fallback at the end. The fallback was the hazard: a
 * phase nobody thought about fell through to "Connect", which is a
 * promise about what the press will do, and the press meanwhile branched
 * on its own chain elsewhere in the file. The two chains agreeing was a
 * property of nobody having edited one of them lately.
 */
const PRESS: Record<ConnectionState, { action: PressAction; labelKey: TranslationKey }> = {
  disconnected: { action: "connect", labelKey: "dash.connect" },
  // Named for what the press actually does. "Connect" here would promise
  // an action the app is in no position to take, on a tunnel it cannot
  // currently see.
  unknown: { action: "recheck", labelKey: "dash.recheck" },
  // Pressable during a pass on purpose -- see ConnectOrb, which is never
  // disabled by a state of its own. A press means stop the attempt, not
  // start a second one.
  connecting: { action: "cancelConnect", labelKey: "dash.connecting" },
  verifying: { action: "cancelConnect", labelKey: "dash.verifying" },
  connected: { action: "disconnect", labelKey: "dash.connected" },
  // An engine is up, so the press that makes sense is the one that takes
  // it down -- the same as `connected`, because the tunnel is equally
  // real in both. Only the label differs, and it has to: promising
  // "Connected" here would be the claim this state exists to withhold.
  unverified: { action: "disconnect", labelKey: "dash.unverifiedShort" },
  degraded: { action: "disconnect", labelKey: "dash.degraded" },
  // Repeating a teardown is safe (there is nothing there twice) and is
  // the way out of a "Disconnecting..." that has stopped describing
  // anything. Doing nothing here is what made the window look frozen.
  disconnecting: { action: "disconnect", labelKey: "dash.disconnecting" },
};

export function pressFor(state: ConnectionState): { action: PressAction; labelKey: TranslationKey } {
  return PRESS[state];
}

/** Which way an action moves the tunnel.
 *
 * Exists so the label and the action can be checked against each other
 * without either one being defined in terms of the other -- see
 * `connect-intent.test.ts`, where the expectation is written out from
 * the customer-facing copy rather than read back out of `PRESS`.
 */
export function movesTunnel(action: PressAction): "up" | "down" | "neither" {
  switch (action) {
    case "connect":
      return "up";
    case "disconnect":
    case "cancelConnect":
      return "down";
    case "recheck":
      return "neither";
  }
}
