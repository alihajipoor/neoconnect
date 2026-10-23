import { sessionGeneration } from "./session-end";

/** The status chip's one bounce: the check on the first verified
 * connection of a session (design-system.md, principle 6), and never
 * again until the customer has ended that session themselves.
 *
 * Not on every arrival at "Connected": a brief reconnect goes check, spin,
 * check, and a bounce at the end of each gap would mark every one of them
 * with motion -- exactly what the calm rule exists to prevent
 * (ui-state-calm). Nor when a load error's banner clears and the chip is
 * drawn again, nor when a screen remounts (Settings opened and closed).
 *
 * Per process, like the mark's float (HeroArt.tsx). A session here is the
 * customer's: it starts again after their own Disconnect (`rearmCheckPop`)
 * and with each signed-in account (`sessionGeneration`, which moves on
 * sign-out). */

let poppedFor: number | null = null;

/** True the first time the check is drawn in this session -- the caller
 * gives it the bounce -- and false after, until the session starts again. */
export function claimCheckPop(session: number = sessionGeneration()): boolean {
  if (poppedFor === session) return false;
  poppedFor = session;
  return true;
}

/** The customer pressed Disconnect: their next verified connection is a new
 * session's first, and bounces again. */
export function rearmCheckPop(): void {
  poppedFor = null;
}
