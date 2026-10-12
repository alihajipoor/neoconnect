/** When the connect orb and the status dot take the warning colour.
 *
 * The owner's rule (2026-10-12): a few seconds of not being connected must
 * not change the button's colour, because people misread it -- a colour
 * change from across a room says "something is wrong, I am exposed", and
 * the customers this is for act on what the screen says. So the warning
 * colour is kept for a real and sustained "connected, not fully protected"
 * (`warnsUnconfined`):
 *
 *  - a confinement that would not go in, or was let go of for good -- shown
 *    only once it has held, unbroken, for `CAUTION_AFTER_MS`. The drop
 *    report that lets go of a confinement for the second or two before a
 *    dead engine's session is torn down, a retracted report put back, a
 *    reading one poll got wrong -- none of those last that long on a
 *    connected screen;
 *  - Built-in (IKEv2), which this version never confines. That is a fact
 *    about the session, not a gap that might close, and it is shown from
 *    the moment the connection is confirmed: waiting ten seconds would only
 *    turn a steady state into a green-then-amber change on every connect.
 *
 * And it is given up the same way: only once the good condition has held
 * as long, so the colour never flickers back and forth.
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

/** Looks further apart than this break "unbroken": the screen was away
 * (Settings open), or its tick stalled, and what happened meanwhile was not
 * seen. The dashboard looks every second. */
export const CAUTION_GAP_MS = 5_000;

export interface CautionState {
  /** Whether the orb and the dot show the warning colour. */
  readonly caution: boolean;
  /** Since when the opposite of `caution` has been seen, unbroken, on a
   * connected screen; null while it is not being seen. */
  readonly since: number | null;
  /** When the last look was taken. */
  readonly seen: number | null;
}

export const NO_CAUTION: CautionState = { caution: false, since: null, seen: null };

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
  // Nothing up: whatever comes next is a new session, and starts green.
  if (look.state === "disconnected") return { caution: false, since: null, seen: now };
  // Up but not confirmed, or on its way somewhere: the orb shows that state's
  // own look, and nothing seen meanwhile counts towards a change either way.
  if (look.state !== "connected") return { caution: prev.caution, since: null, seen: now };
  if (look.unconfined && look.byChoice) return { caution: true, since: null, seen: now };
  const wanted = look.unconfined;
  if (wanted === prev.caution) return { caution: prev.caution, since: null, seen: now };
  const unbroken = prev.since !== null && prev.seen !== null && now - prev.seen <= CAUTION_GAP_MS;
  const since = unbroken ? prev.since! : now;
  if (now - since >= CAUTION_AFTER_MS) return { caution: wanted, since: null, seen: now };
  return { caution: prev.caution, since, seen: now };
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

/** One per app, like the reconnect: the dashboard unmounts whenever
 * Settings opens, and a warning already shown must not go back to green --
 * nor a pending one start counting again -- because the screen came back.
 * A long absence still breaks "unbroken" (`CAUTION_GAP_MS`). */
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
