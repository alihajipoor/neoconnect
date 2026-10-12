/** A connect the service refused for want of a network, waiting for one.
 *
 * Since 1ff7dbc every engine says "no network" before dialling when there
 * is no way out at all (`NO_NETWORK` in the service), at once. The ladder
 * took that as a rung that failed and went on to the next server, so a pass
 * with no network walked the whole list in seconds, and an automatic
 * reconnect spent its six attempts in about a minute and then landed the
 * customer in another country once the network came back (G8, g8-01: fi to
 * sg). Nothing was wrong with fi; there was no network to dial it over.
 *
 * Now the pass waits on the same rung -- no attempt counted, no server or
 * country changed, nothing recorded against the route -- and dials it again
 * when a network with a way out is back. The screen says "Waiting for a
 * network connection" meanwhile (`networkWait`).
 *
 * Whether there is a way out is asked of Windows' routing table
 * (`network_way_out`, the table the service's own refusal reads), every
 * `NETWORK_POLL_MS`. That answer is only a hint for when to try: the service
 * decides, and the rung is dialled again every `NETWORK_RETRY_ANYWAY_MS`
 * regardless -- a dial the service refuses for want of a network costs
 * nothing and names no server -- so a hint that cannot see a way out (a line
 * it misreads) delays a connect by half a minute at most. */

import { BLOCKED_WAIT_MAX_MS } from "./auto-reconnect";

/** How often a waiting pass asks whether a network is back. */
export const NETWORK_POLL_MS = 2_000;

/** How often it dials the same rung again whatever the answer. */
export const NETWORK_RETRY_ANYWAY_MS = 30_000;

/** The longest one rung waits, across every round of it: the same half hour
 * an automatic reconnect waits for a network. Past it, the pass ends and
 * says there is no network -- naming no server. */
export const NETWORK_WAIT_MAX_MS = BLOCKED_WAIT_MAX_MS;

export interface NetworkWaitDeps {
  /** Whether Windows has a way out now. False when it cannot be asked. */
  wayOut(): Promise<boolean>;
  /** The pass has been told to stop, or replaced. */
  stopped(): boolean;
  /** Still alive: renews the ladder's guard and a reconnect's ceiling. */
  progress(): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** `back`: a way out is there. `retry`: none seen, but it is time to let the
 * service look again. Both mean "dial the same rung". */
export type NetworkWaitOutcome = "back" | "retry" | "stopped" | "gaveUp";

/** Waits until a network is back, it is time to try anyway, the pass is
 * stopped, or `since` -- when this rung first found no network -- is
 * `NETWORK_WAIT_MAX_MS` ago. */
export async function waitForNetwork(deps: NetworkWaitDeps, since: number = deps.now()): Promise<NetworkWaitOutcome> {
  const began = deps.now();
  for (;;) {
    if (deps.stopped()) return "stopped";
    if (deps.now() - since >= NETWORK_WAIT_MAX_MS) return "gaveUp";
    await deps.sleep(NETWORK_POLL_MS);
    if (deps.stopped()) return "stopped";
    deps.progress();
    const back = await deps.wayOut().catch(() => false);
    if (deps.stopped()) return "stopped";
    if (back) return "back";
    if (deps.now() - began >= NETWORK_RETRY_ANYWAY_MS) return "retry";
  }
}

/** Whether a pass is waiting for a network now, for the headline. One per
 * app, like the ladder's guard: a screen mounted mid-wait (Settings opened
 * and closed) says it too. */
let waiting = false;
const listeners = new Set<() => void>();

export const networkWait = {
  current: (): boolean => waiting,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  set(next: boolean): void {
    if (waiting === next) return;
    waiting = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One screen's trouble is not the pass's.
      }
    }
  },
};
