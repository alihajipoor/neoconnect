/** The connect ladder's guard, kept outside the screen that runs it.
 *
 * A pass is a long-running thing -- tens of seconds on a filtered
 * network -- and the Dashboard is not: it unmounts whenever Settings or
 * Plans is opened. Nothing cancels a pass on unmount, and nothing
 * should (opening Settings must not abort a connect), so the pass goes on
 * dialling for a screen that is gone. Its guard, its generation and its
 * cancel flag used to be that screen's own `useRef`s, so the Dashboard
 * mounted on return started with a guard reading "no pass", read the
 * service between two rungs, published "disconnected" -- which no poll
 * revisits -- and let a press start a second ladder. Two ladders then
 * took turns tearing down each other's engine through the one service.
 *
 * Here, they are one per app, the way `deviceSlot` and `slotTeardown`
 * already are. Plain `{ current }` holders, so the screen reads and
 * writes them exactly as it did its refs.
 *
 * The phone's dashboard uses the same holders, through `@shared`, with
 * `apps/mobile/src/lib/phone-pass.ts` on top: it had the same per-screen
 * flag and no guard at all, and its automatic reconnect made the second
 * ladder reachable without a press.
 */

import type { BaselineIp, TunnelServer } from "./egress";

/** After this long without a step forward, a ladder pass is presumed
 * never to return.
 *
 * A boolean guard was enough while every step was guaranteed to finish.
 * It is not once a step can hang forever: the pass holding the guard
 * may never reach its own `finally`, and then every press of Connect
 * reads as "cancel the pass in progress" and the app can never connect
 * again. That is the third press that froze the window.
 *
 * Measured from the pass's last sign of life (`progress`, at every rung)
 * rather than from its start. It used to be from the start, sized off
 * "four rejected candidates and a patient last one" -- but the number of
 * candidates is not capped, and a rejected one costs up to a dozen
 * seconds to settle on a filtered network plus its start and verify, so
 * a pass with six or more of them outlived the guard while still
 * dialling, and a press then started a second ladder beside it. One rung
 * is what is bounded: twelve seconds to settle, the service's 38-second
 * connect, thirty to prove egress and eight to confirm reachability on
 * the last, and its teardown -- well inside two and a half minutes, so
 * no live pass is declared dead, and a wedged one still stops holding
 * the app hostage. That holds only while each rung's steps are bounded
 * -- see the Dashboard's `settleAndCaptureBaseline`. */
export const LADDER_MAX_MS = 150_000;

/** Whether a pass is holding the guard. */
const running = { current: false };
/** When the pass holding the guard last made progress -- began, or began
 * a rung -- so the guard can expire. */
const startedAt = { current: 0 };
/** Which pass is the current one. A pass that outlived its deadline has
 * been superseded, and must not clear a newer pass's guard. */
const generation = { current: 0 };
/** Set when the customer asks a pass to stop -- from whichever screen
 * is mounted now, which may not be the one that started it. */
const cancel = { current: false };
/** The address the world saw before this pass's tunnel came up, and
 * which endpoint said so: the egress check's baseline.
 *
 * Here and not in the screen for the same reason as the guard. The pass
 * takes it (once per rung) and the health poll compares against it for
 * the rest of the session -- and when it was the screen's own ref, a
 * Dashboard remounted mid-connect (Settings opened and closed) adopted
 * the pass but not its baseline, so every later poll had nothing to
 * compare and a tunnel being bypassed could not be detected for the rest
 * of the session. Null in a fresh app: a tunnel the service kept up
 * across a restart has no honest "before". */
const baseline: { current: BaselineIp | null } = { current: null };
/** Where the pass's tunnel is dialled -- the server of the rung it is
 * on, and once it lands, of the route it landed on -- and whether this
 * client reaches it around the tunnel. Where it does, the egress check
 * passes over any endpoint there: such an endpoint answers with the
 * customer's own address however well the tunnel works (see
 * `TunnelServer` in egress.ts).
 *
 * Here beside the baseline, and for the same reason: the health poll
 * needs it for the rest of the session, from whichever Dashboard is
 * mounted. Null in a fresh app, like the baseline -- which for a tunnel
 * kept up across a restart leaves nothing to compare, so nothing the
 * server's own mirror says can be held against that tunnel either. */
const tunnelServer: { current: TunnelServer | null } = { current: null };

const endListeners = new Set<() => void>();

/** How often `stopAndWait` looks for a guard that lapsed: a pass wedged
 * past it never says it ended. */
const STOP_POLL_MS = 500;

export const ladderPass = {
  running,
  startedAt,
  generation,
  cancel,
  baseline,
  tunnelServer,

  /** Whether a pass could still be running. */
  inFlight(now = Date.now()): boolean {
    return running.current && now - startedAt.current < LADDER_MAX_MS;
  },

  /** A pass is still alive and moving: called as it starts each rung, so
   * a long ladder keeps its guard while a wedged step still loses it.
   * Only the pass that holds the guard can renew it -- one that outlived
   * it and was replaced must not take it back. */
  progress(pass: number, now = Date.now()): void {
    if (running.current && generation.current === pass) startedAt.current = now;
  },

  /** Told whenever a pass ends, so a screen that adopted a pass it did
   * not start can ask the service what it left behind. Returns the
   * unsubscribe. */
  onEnd(listener: () => void): () => void {
    endListeners.add(listener);
    return () => {
      endListeners.delete(listener);
    };
  },

  /** Tells the pass in flight to stop and waits, for at most `ms`, for it
   * to let go of the guard. True once no pass holds it; false if one
   * still does at the end.
   *
   * For a press whose next step must not share the service with a pass
   * still unwinding: the phone's Connect over an automatic reconnect, and
   * a repair. The pass checks its stop between steps, so it lets go after
   * the step it is on -- and its own teardown -- rather than at once.
   * Bounded, because a pass wedged on a call that never returns never
   * lets go at all. */
  stopAndWait(ms: number): Promise<boolean> {
    cancel.current = true;
    if (!ladderPass.inFlight()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        stopListening();
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(!ladderPass.inFlight());
      };
      const stopListening = ladderPass.onEnd(finish);
      const poll = setInterval(() => {
        if (!ladderPass.inFlight()) finish();
      }, STOP_POLL_MS);
      const deadline = setTimeout(finish, ms);
    });
  },

  /** Called by the pass on its way out, after it has released the guard
   * (or found it no longer its own). */
  ended(): void {
    for (const listener of [...endListeners]) {
      try {
        listener();
      } catch {
        // One screen's trouble is not the pass's.
      }
    }
  },

  /** For tests: back to an app that has never connected. */
  reset(): void {
    running.current = false;
    startedAt.current = 0;
    generation.current = 0;
    cancel.current = false;
    baseline.current = null;
    tunnelServer.current = null;
    endListeners.clear();
  },
};
