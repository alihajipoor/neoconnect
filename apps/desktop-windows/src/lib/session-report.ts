import { reportAttempt, type AttemptReport } from "./attempts";

/** "It connected, and it kept working" -- the half of a connection a
 * CONNECT report cannot say.
 *
 * A route that a censor lets through and then cuts a minute later reads
 * as a success at connect time, and that is exactly the route a customer
 * on a filtered network learns to distrust. The per-ISP tags only call a
 * route good for a network when people on it stayed up, so the clients
 * say so: once per session, after the tunnel has passed its health
 * checks continuously for `SUSTAINED_MS`.
 *
 * Driven by the health poll the dashboards already run, and nothing
 * else: no new probe, no extra traffic, no timer of its own. Sent at the
 * milestone rather than at disconnect, because a session often never
 * ends cleanly -- the phone sleeps, the app is killed -- and a report
 * that waits for a clean ending would miss most of the long ones.
 *
 * It says how long and on which route. Nothing about what was carried.
 */

/** Ten minutes, matching the server's `SUSTAINED_SECONDS`. Measured from
 * the first passing check, so a report always clears the server's bar. */
export const SUSTAINED_MS = 10 * 60_000;

export interface SessionTracker {
  /** A health check just proved traffic is crossing the tunnel on
   * `routeId`. Starts the clock, or sends the report once it has run
   * long enough. */
  healthy(routeId: string | null | undefined, protocol?: string): void;
  /** A check failed, or the tunnel is down or being replaced. The clock
   * starts again from the next passing check -- the claim is continuous
   * health, and a session that dropped out half way has not earned it. */
  broken(): void;
}

export function createSessionTracker(
  report: (r: AttemptReport) => Promise<void> = reportAttempt,
  now: () => number = Date.now,
): SessionTracker {
  let current: { routeId: string; protocol?: string; since: number; sent: boolean } | null = null;

  return {
    healthy(routeId, protocol) {
      if (!routeId) return;
      const at = now();
      if (!current || current.routeId !== routeId) {
        current = { routeId, protocol, since: at, sent: false };
        return;
      }
      if (current.sent || at - current.since < SUSTAINED_MS) return;
      current.sent = true;
      void report({
        kind: "SESSION",
        outcome: "SUCCESS",
        routeId,
        protocol: current.protocol,
        sessionSeconds: Math.floor((at - current.since) / 1000),
      });
    },
    broken() {
      current = null;
    },
  };
}
