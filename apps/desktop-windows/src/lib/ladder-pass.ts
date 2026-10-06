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
 */

/** After this, a ladder pass is presumed never to return.
 *
 * A boolean guard was enough while every step was guaranteed to finish.
 * It is not once a step can hang forever: the pass holding the guard
 * may never reach its own `finally`, and then every press of Connect
 * reads as "cancel the pass in progress" and the app can never connect
 * again. That is the third press that froze the window.
 *
 * Sized off the ladder's own worst case rather than picked: four
 * rejected candidates at roughly ten seconds each, plus a last one
 * given the patient budgets (six to settle, thirty to prove egress,
 * eight to confirm reachability), lands near ninety seconds. Two and a
 * half minutes is comfortably past that, so no real pass is ever
 * declared dead, and a wedged one stops holding the app hostage. That
 * sizing holds only while each candidate's settle is bounded -- see
 * the Dashboard's `settleAndCaptureBaseline`. */
export const LADDER_MAX_MS = 150_000;

/** Whether a pass is holding the guard. */
const running = { current: false };
/** When the pass holding the guard began, so the guard can expire. */
const startedAt = { current: 0 };
/** Which pass is the current one. A pass that outlived its deadline has
 * been superseded, and must not clear a newer pass's guard. */
const generation = { current: 0 };
/** Set when the customer asks a pass to stop -- from whichever screen
 * is mounted now, which may not be the one that started it. */
const cancel = { current: false };

const endListeners = new Set<() => void>();

export const ladderPass = {
  running,
  startedAt,
  generation,
  cancel,

  /** Whether a pass could still be running. */
  inFlight(now = Date.now()): boolean {
    return running.current && now - startedAt.current < LADDER_MAX_MS;
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
    endListeners.clear();
  },
};
