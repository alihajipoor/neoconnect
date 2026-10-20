/** When the connect control and the status chip take the warning colour.
 *
 * The owner's rule (2026-10-12): a few seconds of not being connected must
 * not change the button's colour, because people misread it -- a colour
 * change from across a room says "something is wrong, I am exposed", and
 * the customers this is for act on what the screen says. So the warning
 * colour is kept for a real and sustained "connected, not fully protected"
 * (`warnsUnconfined`):
 *
 *  - a session's colour is set at its first confirmed look, as the service
 *    says it then: a connect, a switch, a reconnect, or a screen opened onto
 *    a session already up. A confinement that would not go in at connect is
 *    a fact about the session, like Built-in's, and shown from the start --
 *    waiting would only turn a steady state into a green-then-amber change
 *    in front of the customer;
 *  - within a session the screen has been watching, the colour changes
 *    only once the new condition has held, unbroken, for
 *    `CAUTION_AFTER_MS`. The drop report that lets go of a confinement for
 *    the second or two before a dead engine's session is torn down, a
 *    retracted report put back, a reading one poll got wrong -- none of
 *    those last that long on a connected screen. And it is given up the
 *    same way, so the colour never flickers back and forth. "Unbroken" is
 *    what was seen, not how often: the dashboard looks at every change of
 *    what the service says as it lands, so looks a minute apart -- a
 *    minimized window's throttled timers -- hide nothing;
 *  - Built-in (IKEv2), which this version never confines, at once and for
 *    as long as it is connected.
 *
 * Everything else keeps the look it has. A reconnect, a ladder rung and an
 * engine restart are "connecting" / "verifying", and the unconfined gap
 * after an engine crash ends in one of those; the warning is only ever
 * drawn over a confirmed connection (`orbTone`). While a reconnect nobody
 * pressed for runs, the screen holds the look -- this colour included --
 * that the session had (`orbHold`, below), for at most `CAUTION_AFTER_MS`.
 *
 * The headline is not this file's. It says "Connected, not fully
 * protected" the moment the service says so, and never "You're protected"
 * without proof: honesty is not delayed with the colour. */

import type { ConnectionState } from "../components/ConnectOrb";

/** How long "not fully protected" has to hold, unbroken, before the colour
 * changes -- and how long the good condition has to hold before it changes
 * back. */
export const CAUTION_AFTER_MS = 10_000;

export interface CautionState {
  /** Whether the orb and the dot show the warning colour. */
  readonly caution: boolean;
  /** Since when the opposite of `caution` has been seen, unbroken, on a
   * connected screen; null while it is not being seen. */
  readonly since: number | null;
  /** No confirmed look at this session yet: the next one sets the colour
   * as it finds it. */
  readonly fresh: boolean;
}

export const NO_CAUTION: CautionState = { caution: false, since: null, fresh: true };

export interface CautionLook {
  readonly state: ConnectionState;
  /** The service says this full tunnel should hold the machine's IPv4 to it
   * and does not (`warnsUnconfined`). */
  readonly unconfined: boolean;
  /** And not by accident: Built-in (IKEv2), never confined in this version
   * (`unconfinedByChoice`). */
  readonly byChoice: boolean;
}

/** The state after one more look at the screen, at `now`. */
export function nextCaution(prev: CautionState, look: CautionLook, now: number): CautionState {
  switch (look.state) {
    // Nothing up, or on its way up or down: what comes next is a session of
    // its own -- a connect, a switch that never passes "disconnected", a
    // reconnect -- and its first confirmed look says what it is. So does a
    // screen's own first look, before it has asked the service: a dashboard
    // back from Settings starts at "disconnected", and then shows the
    // session as the service has it, not green for ten seconds first.
    case "disconnected":
    case "connecting":
    case "verifying":
    case "disconnecting":
      return { caution: false, since: null, fresh: true };
    // Up but not confirmed: that state's own look, and nothing seen
    // meanwhile counts towards a change either way.
    case "unverified":
    case "degraded":
    case "unknown":
      return { caution: prev.caution, since: null, fresh: prev.fresh };
    case "connected":
      break;
  }
  if (look.unconfined && look.byChoice) return { caution: true, since: null, fresh: false };
  const wanted = look.unconfined;
  if (prev.fresh) return { caution: wanted, since: null, fresh: false };
  if (wanted === prev.caution) return { caution: prev.caution, since: null, fresh: false };
  // Counted from when it was first seen, however far apart the looks:
  // every change is looked at as it lands, so nothing between two looks
  // went unseen (a minimized window's timers run once a minute).
  const since = prev.since ?? now;
  if (now - since >= CAUTION_AFTER_MS) return { caution: wanted, since: null, fresh: false };
  return { caution: prev.caution, since, fresh: false };
}

/** The look the orb and the dot take: a connected tunnel's success colour,
 * or the warning one when the caution holds; every other state its own,
 * caution or not. */
export type OrbTone = "success" | "caution" | "warning" | "highlight" | "muted" | "busy" | "idle";

export function orbTone(state: ConnectionState, caution: boolean): OrbTone {
  switch (state) {
    case "connected":
      return caution ? "caution" : "success";
    case "degraded":
      return "warning";
    case "unverified":
      return "highlight";
    case "unknown":
      return "muted";
    case "connecting":
    case "verifying":
    case "disconnecting":
      return "busy";
    case "disconnected":
      return "idle";
  }
}

/** What the connect control and the status chip are drawn as: the
 * session's state, held over a short gap.
 *
 * The same owner's rule, for the other colours. A confirmed session whose
 * health check fails once, or whose reading lapses for a poll, goes to
 * "degraded", "unverified" or "unknown" -- amber, teal, grey -- and is
 * usually "connected" again a few seconds later. So a session keeps the
 * look it settled on until the gap has held, unbroken, for
 * `CAUTION_AFTER_MS`; then the screen takes the gap's own look. The
 * headline and its line still say what the service says, at once: honesty
 * is not delayed with the colour.
 *
 * Reconnects are gaps too (owner decision, 2026-10-19, extending the rule
 * of 2026-10-12, which names them among the gaps that must not change the
 * colour). It used to stop at a drop: "disconnected", and the reconnect's
 * busy look, showed at once, so every automatic reconnect -- an engine
 * restart, a roam -- flashed the screen from cobalt to grey and back. Now
 * an episode nobody pressed for holds the settled look as well:
 *
 *  - a pass the customer did not start -- an automatic reconnect's
 *    attempt, or the health poll's failover -- ("connecting",
 *    "verifying");
 *  - and, while an automatic reconnect is under way, the moments between
 *    its attempts ("disconnected", "disconnecting").
 *
 * What is held is the look a session settled on: "connected", or
 * "unverified" (a brief gap from "not confirmed" keeps teal). Never a look
 * the session has not had -- a first look, or one after a connect, shows
 * as it is -- and never over a press: anything the customer starts shows
 * at once. A drop with no reconnect to follow is not held either: "VPN
 * connection lost" is said, and coloured, at once. The words, and the
 * check glyph that only a verified tunnel carries, follow the service
 * whatever the colour holds. */
export interface OrbLook {
  readonly state: ConnectionState;
  /** Since when the shown look has been held over a gap; null while
   * nothing is held. */
  readonly since: number | null;
  /** The warning colour shown with it (`orbCaution`): the held one while
   * held, so a session that was "not fully protected" is not shown fully
   * protected for the length of its reconnect. */
  readonly caution: boolean;
}

export const NO_ORB_LOOK: OrbLook = { state: "disconnected", since: null, caution: false };

/** What the screen is doing beside the state, for one look. */
export interface HoldContext {
  /** An automatic reconnect is under way (`reconnectingView`). */
  readonly reconnecting?: boolean;
  /** A press of the customer's is in flight -- Connect, Disconnect, Stop,
   * Check again, a switch of location. Nothing is held over one. */
  readonly pressed?: boolean;
  /** Whether the warning colour shows with this look (`orbCaution`). */
  readonly caution?: boolean;
}

/** The looks a session settles on, and holds through a gap. */
function settledUp(state: ConnectionState): boolean {
  return state === "connected" || state === "unverified";
}

/** Whether `state` is a gap in a settled session, rather than a change
 * somebody asked for or the end of it. */
function isGap(state: ConnectionState, context: HoldContext): boolean {
  switch (state) {
    case "degraded":
    case "unverified":
    case "unknown":
      return true;
    case "connecting":
    case "verifying":
      return !context.pressed;
    case "disconnected":
    case "disconnecting":
      return context.reconnecting === true && !context.pressed;
    case "connected":
      return false;
  }
}

export function nextOrbLook(prev: OrbLook, state: ConnectionState, now: number, context: HoldContext = {}): OrbLook {
  const caution = context.caution ?? false;
  if (context.pressed || state === prev.state || !settledUp(prev.state) || !isGap(state, context)) {
    return { state, since: null, caution };
  }
  const since = prev.since ?? now;
  if (now - since >= CAUTION_AFTER_MS) return { state, since: null, caution };
  return { state: prev.state, since, caution: prev.caution };
}

let orbLook: OrbLook = NO_ORB_LOOK;

/** One per app, like the caution below. */
export const orbHold = {
  /** Takes a look, and returns the state the control is drawn as. */
  observe(state: ConnectionState, context: HoldContext = {}, now = Date.now()): ConnectionState {
    orbLook = nextOrbLook(orbLook, state, now, context);
    return orbLook.state;
  },
  current: (): ConnectionState => orbLook.state,
  /** The warning colour drawn with it: the held one while held. */
  caution: (): boolean => orbLook.caution,
  /** Whether a look is being held over a gap right now. */
  holding: (): boolean => orbLook.since !== null,
  /** For tests: a fresh app. */
  reset(): void {
    orbLook = NO_ORB_LOOK;
  },
};

/** One per app, like the reconnect: the dashboard unmounts whenever
 * Settings opens. A screen that comes back looks first at its own
 * "disconnected", and then shows the session as the service has it at its
 * first confirmed look (`nextCaution`) -- never green over a warning
 * because of the navigation. */
let current: CautionState = NO_CAUTION;

export const orbCaution = {
  /** Takes a look, and returns whether the warning colour shows. */
  observe(look: CautionLook, now = Date.now()): boolean {
    current = nextCaution(current, look, now);
    return current.caution;
  },
  current: (): boolean => current.caution,
  /** For tests: a fresh app. */
  reset(): void {
    current = NO_CAUTION;
  },
};
