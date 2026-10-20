/** The reconnect's own line: "Attempt 2 of 6 · next try in 3 s" between
 * attempts, "Attempt 2 of 6" during one (design-system.md, 4.6).
 *
 * The wait carries no due time on purpose -- a due time read off the wall
 * clock was how a clock set back once stranded "Reconnecting..." with
 * nothing dialling (auto-reconnect.ts, `waiting`). So the countdown is
 * measured here on the monotonic clock, from the moment this run first saw
 * the wait, against the backoff the wait stands for. It can only run
 * slow, never claim a try that has not been made: at zero it says the try
 * is starting, and the phase moves on when it does.
 *
 * A wait for a network says nothing here: the headline already says
 * "Waiting for a network connection", and there is no time to count. */

import type { ReconnectPhase } from "./auto-reconnect";
import { RECONNECT_MAX_ATTEMPTS } from "./auto-reconnect";

export type CountdownLine =
  | { readonly kind: "next"; readonly attempt: number; readonly max: number; readonly seconds: number }
  | { readonly kind: "now"; readonly attempt: number; readonly max: number }
  | { readonly kind: "attempt"; readonly attempt: number; readonly max: number };

/** `seenAt` is when this wait was first seen, on the same clock as `now`. */
export function countdownLine(phase: ReconnectPhase, seenAt: number | null, now: number): CountdownLine | null {
  const max = RECONNECT_MAX_ATTEMPTS;
  if (phase.kind === "attempting") {
    return phase.offline ? null : { kind: "attempt", attempt: phase.attempt + 1, max };
  }
  if (phase.kind !== "waiting" || phase.blockedBy !== null) return null;
  const attempt = phase.attempt + 1;
  if (phase.delayMs <= 0 || seenAt === null) return { kind: "now", attempt, max };
  const seconds = Math.ceil((seenAt + phase.delayMs - now) / 1000);
  return seconds >= 1 ? { kind: "next", attempt, max, seconds } : { kind: "now", attempt, max };
}
