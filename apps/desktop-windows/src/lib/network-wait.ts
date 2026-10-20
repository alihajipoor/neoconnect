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
 * Whether there is a way out is asked of Windows' routing table by the
 * service's own rule (`network_way_out`: a route on an adapter that is up
 * and not one of ours, as its refusal takes one -- the best route alone,
 * wherever it led, said yes with the cable out and ended every wait at its
 * first look): soon after the refusal, and less often the longer the wait,
 * up to every `NETWORK_POLL_MS` (`nextLookIn`). That answer is only a hint
 * for when to try: the service
 * decides, and the rung is dialled again every `NETWORK_RETRY_ANYWAY_MS`
 * regardless -- a dial the service refuses for want of a network costs
 * nothing and names no server -- so a hint that cannot see a way out (a line
 * it misreads) delays a connect by half a minute at most. */

import { BLOCKED_WAIT_MAX_MS } from "./auto-reconnect";

/** How often a waiting pass asks whether a network is back, once it has
 * waited a while. */
export const NETWORK_POLL_MS = 2_000;

/** How soon it first asks, after the service's first refusal on a rung.
 *
 * Measured on the VM (R3d, the guest's link off for four seconds): the
 * reconnect's dial went out once the browser said the network was back,
 * 1.5 s after the address returned, and was refused -- the default route
 * not there yet. The first look again came `NETWORK_POLL_MS` later
 * whatever had come back in the meantime, and found a way out at once.
 * A refusal like that is a network on its way back, so the wait looks
 * again within a quarter of a second, and then every quarter of the time
 * it has waited, up to `NETWORK_POLL_MS`: a network that comes back is
 * noticed within a quarter of the time it took. Each look is a local
 * routing-table read; nothing is dialled, and nothing leaves the machine. */
export const NETWORK_FIRST_LOOK_MS = 250;

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

/** How long to wait before the next look, `waited` into this round of the
 * wait, `round` being how many rounds this rung has waited already -- each
 * one ended by a dial the service refused again.
 *
 * A quarter of the time waited, between `NETWORK_FIRST_LOOK_MS` and
 * `NETWORK_POLL_MS`. Never hammering: what a look can lead to is a dial,
 * and a hint the service keeps refusing -- the two read the routing table
 * with different questions, and could disagree for good -- would have it
 * dialled at every first look. So the first look of each later round
 * comes twice as late as the last one's did, up to `NETWORK_POLL_MS`: the
 * pace the wait always had. */
export function nextLookIn(waited: number, round: number): number {
  const first = Math.min(NETWORK_FIRST_LOOK_MS * 2 ** Math.max(0, round), NETWORK_POLL_MS);
  return Math.min(NETWORK_POLL_MS, Math.max(first, Math.round(waited / 4)));
}

/** Waits until a network is back, it is time to try anyway, the pass is
 * stopped, or `since` -- when this rung first found no network -- is
 * `NETWORK_WAIT_MAX_MS` ago. `round`: how many times this rung has waited
 * already (`nextLookIn`). */
export async function waitForNetwork(
  deps: NetworkWaitDeps,
  since: number = deps.now(),
  round = 0,
): Promise<NetworkWaitOutcome> {
  const began = deps.now();
  for (;;) {
    if (deps.stopped()) return "stopped";
    if (deps.now() - since >= NETWORK_WAIT_MAX_MS) return "gaveUp";
    await deps.sleep(nextLookIn(deps.now() - began, round));
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
