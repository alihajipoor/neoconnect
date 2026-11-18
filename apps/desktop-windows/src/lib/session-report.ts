import { reportAttempt, type AttemptReport } from "./attempts";
import type { SessionEndCause } from "./report-details";

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

/** The shortest session whose end is reported (`ended`). A tunnel that
 * lived less than a minute is a connect's story, which its CONNECT report
 * already tells. */
export const SESSION_END_MIN_MS = 60_000;

export interface SessionTracker {
  /** A health check just proved traffic is crossing the tunnel on
   * `routeId`. Starts the clock, or sends the report once it has run
   * long enough. */
  healthy(routeId: string | null | undefined, protocol?: string): void;
  /** A check failed, or the tunnel is down or being replaced. The clock
   * starts again from the next passing check -- the claim is continuous
   * health, and a session that dropped out half way has not earned it. */
  broken(): void;
  /** The session is over: the customer pressed disconnect, the tunnel was
   * lost, or another server replaced it. Sends one end report, with the
   * cause and how long the session ran since its first passing check --
   * only when that was at least `SESSION_END_MIN_MS`, and never twice for
   * one session. A session never ended this way (the app was killed) sends
   * none. */
  ended(cause: SessionEndCause): void;
}

export function createSessionTracker(
  report: (r: AttemptReport) => Promise<void> = reportAttempt,
  now: () => number = Date.now,
): SessionTracker {
  let current: { routeId: string; protocol?: string; since: number; sent: boolean } | null = null;
  /** The session as a whole: from its first passing check to its end,
   * through any failed checks between. Not reset by `broken`, which only
   * restarts the continuous-health clock above. */
  let session: { routeId: string; protocol?: string; since: number } | null = null;

  const end = (cause: SessionEndCause) => {
    const ending = session;
    // Taken before anything is sent: one end per session, whatever calls next.
    session = null;
    if (!ending) return;
    const ran = now() - ending.since;
    if (ran < SESSION_END_MIN_MS) return;
    const seconds = Math.min(Math.floor(ran / 1000), 7 * 86_400);
    void report({
      kind: "SESSION",
      // Not SUCCESS, and no `sessionSeconds`: the server counts a SUCCESS
      // with seconds as ten minutes of continuous health, which this does
      // not claim.
      outcome: "OTHER",
      routeId: ending.routeId,
      protocol: ending.protocol,
      reason: `session ended (${cause}) after ${seconds} s; not an attempt`,
      details: { sessionEnd: { cause, seconds } },
    });
  };

  return {
    healthy(routeId, protocol) {
      if (!routeId) return;
      const at = now();
      // Another route took over without this session being ended: a switch.
      if (session && session.routeId !== routeId) end("replaced");
      session ??= { routeId, protocol, since: at };
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
    ended(cause) {
      current = null;
      end(cause);
    },
  };
}
