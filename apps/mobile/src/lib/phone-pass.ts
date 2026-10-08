import type { ReconnectAttempt } from "@shared/lib/auto-reconnect";
import { ladderPass } from "@shared/lib/ladder-pass";

/** The phone's connect ladder, owned by the app rather than by the screen
 * that started it.
 *
 * A pass is long-running -- tens of seconds on a filtered network -- and
 * the dashboard is not: it unmounts whenever Settings opens. Its stop flag
 * used to be the screen's own `useRef`, and the phone had no guard at
 * all, while the automatic reconnect's episode is one per app. So:
 *
 *  - a pass started before Settings was opened and closed could not be
 *    stopped from the screen mounted on return. "Stop reconnecting" there
 *    set that screen's flag, the pass read the old one, and a tunnel came
 *    up after the customer had said stop;
 *  - Connect, pressed there or while an attempt was still asking the
 *    platform its questions, started a second ladder beside the first,
 *    and the two took turns tearing down each other's engine through the
 *    one VPN service;
 *  - a pass's stop could be wiped: the ladder cleared the flag as it
 *    began, so a stop pressed while an attempt was still asking its
 *    questions was undone before anything read it.
 *
 * Here the guard, the generation and the stop flag are the ones the
 * Windows client keeps outside its screen (`ladderPass`, shared through
 * `@shared`), so every dashboard instance and every press reaches the one
 * pass. What the phone adds is which kind of pass holds the guard -- a
 * press of Connect outranks an automatic reconnect's, and only that --
 * and the episode's own word that an automatic pass is still wanted.
 *
 * The guard lapses after `LADDER_MAX_MS` without a step forward, as on
 * Windows. A phone's rung is bounded by its own ceilings -- the wait for a
 * teardown, the baseline walk, the egress check -- and by how long the
 * platform takes to start an engine. */

/** Whether the pass holding the guard is an automatic reconnect's. */
const reconnecting = { current: false };

/** A pass that holds the guard. */
export interface PhonePass {
  readonly generation: number;
  /** Whether this pass has been told to stop: a press from whichever
   * screen is mounted (the app's one stop flag), the reconnect episode it
   * dials for having ended or moved on, or a newer pass having replaced it
   * once its guard lapsed. Asked after every await, and before every
   * dial. */
  stopped(): boolean;
  /** Whether it is still the current pass. Only then may it take down
   * what it brought up, or say anything about the tunnel: once replaced,
   * whatever is up is the newer pass's. */
  owns(): boolean;
  /** Called at every rung: still alive, so a long ladder keeps its guard
   * -- and an automatic pass its attempt -- while a step that hangs still
   * loses it. */
  progress(): void;
  /** On the way out, however the pass ended. Releases the guard -- if
   * this pass still holds it -- and tells every screen listening
   * (`ladderPass.onEnd`). */
  end(): void;
}

/** Takes the guard for a new pass.
 *
 * "declined" while another pass holds it: never two ladders at once.
 * "cancelled" for an automatic reconnect's attempt that has already been
 * ended -- a press, a sign-out, the device limit -- in which case nothing
 * is taken and nothing is reset: the stop that press set stands. Taken,
 * the stop flag starts clear, because nothing has asked this pass to stop
 * yet: a stop for an earlier pass is not one for this. */
export function beginPass(reconnect?: ReconnectAttempt, now = Date.now()): PhonePass | "declined" | "cancelled" {
  if (reconnect !== undefined && !reconnect.live()) return "cancelled";
  if (ladderPass.inFlight(now)) return "declined";
  const generation = ++ladderPass.generation.current;
  ladderPass.running.current = true;
  ladderPass.startedAt.current = now;
  ladderPass.cancel.current = false;
  reconnecting.current = reconnect !== undefined;
  const owns = () => ladderPass.generation.current === generation;
  return {
    generation,
    stopped: () => ladderPass.cancel.current || !owns() || (reconnect !== undefined && !reconnect.live()),
    owns,
    // The guard, and an automatic pass's attempt: its ceiling is measured
    // from the last rung too (`ATTEMPT_MAX_MS`), or a long ladder is given
    // up on while it is still dialling.
    progress: () => {
      ladderPass.progress(generation);
      reconnect?.progress();
    },
    end: () => {
      // A pass that outlived its guard has been replaced, and releasing
      // the guard now would let a third pass start beside the second.
      if (!owns()) return;
      ladderPass.running.current = false;
      reconnecting.current = false;
      ladderPass.ended();
    },
  };
}

/** Whether a pass could still be running, from whichever screen. */
export function passInFlight(now = Date.now()): boolean {
  return ladderPass.inFlight(now);
}

/** Whether the pass running is an automatic reconnect's. */
export function reconnectPassInFlight(now = Date.now()): boolean {
  return ladderPass.inFlight(now) && reconnecting.current;
}

/** How long a press of Connect waits for an automatic reconnect's pass to
 * let go. That pass checks its stop after every step, and the longest step
 * between two checks is a baseline walk (`BASELINE_WALK_MS`, twelve
 * seconds) or the platform starting an engine; past this, the press says
 * an attempt is still running rather than dial beside it. */
export const TAKEOVER_WAIT_MS = 20_000;

/** Tells the pass in flight to stop and waits, bounded, for it to let go
 * of the guard. True once no pass holds it; false if one still does at
 * the end of `ms`. The wait itself is `ladderPass.stopAndWait`, which the
 * Windows repair shares. */
export function stopPassInFlight(ms = TAKEOVER_WAIT_MS): Promise<boolean> {
  return ladderPass.stopAndWait(ms);
}

/** For tests: back to an app that has never connected. */
export function resetPhonePass(): void {
  ladderPass.reset();
  reconnecting.current = false;
}
