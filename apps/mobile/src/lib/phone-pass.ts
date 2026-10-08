import type { ReconnectAttempt, ReconnectStamp } from "@shared/lib/auto-reconnect";
import { ladderPass } from "@shared/lib/ladder-pass";
import type { ProtocolUser } from "@shared/lib/types";

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
 * Windows -- counting only time the app is in front (`passAwayChanged`),
 * since the OS freezes a pass in the background. A phone's rung is bounded
 * by its own ceilings -- the wait for a teardown, the baseline walk, the
 * egress check -- and by how long the platform takes to start an engine. */

/** Whether the pass holding the guard is an automatic reconnect's. */
const reconnecting = { current: false };

/** Counts the customer's presses, from whichever screen: a press still
 * waiting on something -- Connect waiting for an automatic pass to let go,
 * then for a teardown -- can tell that a later one has taken over from it.
 *
 * One per app, like the stop flag. It was the screen's own `useRef`, so a
 * Connect left waiting on a screen that unmounted (Settings opened and
 * closed during the wait) never heard the stop pressed on the screen
 * mounted on return: it went on once the pass let go, cleared the stop as
 * its own pass began, and dialled after the customer had said stop. */
export const presses = { current: 0 };

/** What the platform has up, as far as the passes know it: the credential
 * the last pass landed on, as its own screen showed it -- proven, or
 * "Connected, not confirmed" -- or `"unproven"`: the last pass dialled an
 * engine it did not land on, which had not gone by the time the pass
 * stopped waiting for it. Null when no pass has said: nothing left up by
 * one, or a fresh app, which may have found a tunnel the platform kept.
 *
 * A screen that did not run the pass reads the platform when it ends --
 * mounted since, back from Settings -- and the platform cannot say which
 * credential is up, or whether the pass proved it. It said "up" of a failed
 * rung's engine still on its way down past the pass's eight-second wait,
 * and the screen showed "You're protected" over a tunnel the pass had just
 * rejected and armed the reconnect over it, ending the episode's remaining
 * attempts. And over a tunnel the pass had proven on another route than
 * the one on screen, the health poll credited that tunnel's sustained
 * success to the screen's route -- the one that had failed on this network
 * -- for the per-ISP tags. Set by the pass, the only thing that brings a
 * tunnel up; one app's, like the guard. */
export const passTunnel: { current: ProtocolUser | "unproven" | null } = { current: null };

/** A press of Connect that followed the pass holding the guard
 * (`pressOverPass` "follow", or a Connect turned away because that pass
 * took the guard first): which pass, and the stamp taken at that press.
 * See `followPass`. */
const followed: { generation: number; stamp: ReconnectStamp | null } = { generation: 0, stamp: null };

/** A pass that holds the guard. */
export interface PhonePass {
  readonly generation: number;
  /** Whether this pass has been told to stop: a press from whichever
   * screen is mounted (the app's one stop flag), the reconnect episode it
   * dials for having ended or moved on, or a newer pass having replaced it
   * once its guard lapsed. Asked after every await, and before every
   * dial. */
  stopped(): boolean;
  /** Whether what stopped it was a press: the app's stop flag, set for
   * this pass. Not when only its attempt is over -- its ceiling, half an
   * hour away, a session that ended out of sight -- or a newer pass
   * replaced it. Only a press is the customer giving up; the rest was filed
   * as "cancelled by the customer" about somebody who pressed nothing, and
   * the episode files why it ended itself. */
  pressed(): boolean;
  /** Whether it is still the current pass. Only then may it take down
   * what it brought up, or say anything about the tunnel: once replaced,
   * whatever is up is the newer pass's. */
  owns(): boolean;
  /** Called at every rung: still alive, so a long ladder keeps its guard
   * -- and an automatic pass its attempt -- while a step that hangs still
   * loses it. */
  progress(): void;
  /** The stamp this pass's landing quotes to the reconnect
   * (`autoReconnect.tunnelUp`): the one taken at the latest press of
   * Connect that followed it (`followPass`), or else `own`, the one the
   * pass took as it began. */
  landing(own: ReconnectStamp): ReconnectStamp;
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
    // A newer pass clears the flag as it begins, and a stop pressed for it
    // is not one for this.
    pressed: () => ladderPass.cancel.current && owns(),
    owns,
    // The guard, and an automatic pass's attempt: its ceiling is measured
    // from the last rung too (`ATTEMPT_MAX_MS`), or a long ladder is given
    // up on while it is still dialling.
    progress: () => {
      ladderPass.progress(generation);
      reconnect?.progress();
    },
    landing: (own) => (followed.generation === generation && followed.stamp !== null ? followed.stamp : own),
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

/** What a press of Connect does about a pass still holding the guard.
 *
 *  - `"none"`: nothing holds it; dial.
 *  - `"follow"`: the customer's own connect, still wanted, is what this
 *    press asked for. It is shown, and its end read when it comes -- never
 *    a second ladder beside it.
 *  - `"takeOver"`: anything else. An automatic reconnect's pass, which a
 *    press outranks; one the customer has already stopped, still unwinding
 *    -- the claim, a baseline walk of up to twelve seconds, its teardown --
 *    whose Connect is a new request, not that pass; and any pass when the
 *    press is "Use on this device instead", which asks for something no
 *    pass running asked for. Told to stop, waited for, and then this press
 *    dials. Followed instead, a Connect pressed over a stopped pass did
 *    nothing at all: the orb read Connect, the pass ended cancelled, and
 *    nothing was dialled or said. */
export function pressOverPass(
  { takeover = false }: { takeover?: boolean } = {},
  now = Date.now(),
): "none" | "follow" | "takeOver" {
  if (!ladderPass.inFlight(now)) return "none";
  if (reconnecting.current || ladderPass.cancel.current || takeover) return "takeOver";
  return "follow";
}

/** A press of Connect follows the pass holding the guard: the customer's
 * own connect, still wanted -- what the press asked for. Its landing is
 * this press's as much as that pass's, and quotes `stamp`, taken at this
 * press, after the press's own `autoReconnect.cancel`.
 *
 * Every press counts as an overrule (`autoReconnect.cancel`, even with
 * nothing to end), and the pass's own stamp was taken before this one. So
 * the landing of the very connect the press chose to follow was refused as
 * overruled: "You're protected" over a tunnel nothing had armed, whose
 * drop then said "VPN connection lost" and reconnected nothing.
 *
 * Only for the customer's own pass, still wanted. An automatic reconnect's,
 * or one already stopped, is taken over rather than followed
 * (`pressOverPass`), and keeps the stamp it began with. A later press
 * overrules this stamp as it would the pass's own. True when the pass
 * holding the guard will quote it. */
export function followPass(stamp: ReconnectStamp, now = Date.now()): boolean {
  if (!ladderPass.inFlight(now) || reconnecting.current || ladderPass.cancel.current) return false;
  followed.generation = ladderPass.generation.current;
  followed.stamp = stamp;
  return true;
}

/** A phone app gone to the background, or back to the front: the guard's
 * clock is held while it is away (`ladderPass.hold`), as the reconnect's
 * attempt ceiling is. */
export function passAwayChanged(away: boolean, now = Date.now()): void {
  if (away) ladderPass.hold(now);
  else ladderPass.resume(now);
}

// Registered once, for the life of the app, as the reconnect's own are:
// the guard outlives every screen.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => passAwayChanged(document.visibilityState === "hidden"));
}

/** How long a press of Connect waits for a pass it outranks
 * (`pressOverPass`) -- an automatic reconnect's, or one already stopped --
 * to let go. That pass checks its stop after every step, and the longest step
 * between two checks is a baseline walk (`BASELINE_WALK_MS`, twelve
 * seconds) or the platform starting an engine -- after which a pass with
 * an engine up waits for it to be gone (eight seconds at most, usually
 * under one); past this, the press says an attempt is still running
 * rather than dial beside it. */
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
  presses.current = 0;
  passTunnel.current = null;
  followed.generation = 0;
  followed.stamp = null;
}
