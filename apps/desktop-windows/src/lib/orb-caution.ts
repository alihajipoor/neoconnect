/** When the connect orb and the status dot take the warning colour.
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
 * engine restart are "connecting" / "verifying" -- the busy look -- and the
 * unconfined gap after an engine crash ends in one of those; the warning is
 * only ever drawn over a confirmed connection (`orbTone`).
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

/** What the orb and the status dot are drawn as: the session's state, held
 * over a short gap.
 *
 * The same owner's rule, for the other colours. A confirmed session whose
 * health check fails once, or whose reading lapses for a poll, goes to
 * "degraded", "unverified" or "unknown" -- amber, cyan, grey -- and is
 * usually "connected" again a few seconds later. So a confirmed session
 * keeps its connected look until the up-but-unconfirmed condition has held,
 * unbroken, for `CAUTION_AFTER_MS`; then the orb takes that state's own
 * look. The headline and its line still say what the service says, at
 * once: honesty is not delayed with the colour.
 *
 * Only ever held over a look the session has had: a first look, a connect
 * and a reconnect are shown as they are. A drop is not held either:
 * "disconnected", and the reconnect's busy look, are the existing
 * "Reconnecting..." the owner's rule leaves transient gaps to. */
export interface OrbLook {
  readonly state: ConnectionState;
  /** Since when the shown "connected" has been held over an
   * up-but-unconfirmed state; null while nothing is held. */
  readonly since: number | null;
}

export const NO_ORB_LOOK: OrbLook = { state: "disconnected", since: null };

export function nextOrbLook(prev: OrbLook, state: ConnectionState, now: number): OrbLook {
  const gap = state === "degraded" || state === "unverified" || state === "unknown";
  if (!gap || prev.state !== "connected") return { state, since: null };
  const since = prev.since ?? now;
  if (now - since >= CAUTION_AFTER_MS) return { state, since: null };
  return { state: "connected", since };
}

let orbLook: OrbLook = NO_ORB_LOOK;

/** One per app, like the caution below. */
export const orbHold = {
  /** Takes a look, and returns the state the orb is drawn as. */
  observe(state: ConnectionState, now = Date.now()): ConnectionState {
    orbLook = nextOrbLook(orbLook, state, now);
    return orbLook.state;
  },
  current: (): ConnectionState => orbLook.state,
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
