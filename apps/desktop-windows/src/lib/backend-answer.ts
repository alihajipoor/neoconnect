/** Who is told that Neoxify answered something this app sent.
 *
 * Kept apart from api.ts because not every request to Neoxify goes
 * through it. The updater asks the API's `/updates` endpoints itself
 * (updates.ts), and the egress check asks `/health/ip` through a command
 * of its own (egress.ts). On the test VM both were answered while the
 * dashboard said "Can't reach Neoxify right now": the updater's check 43
 * seconds before the banner changed, the tunnel's health check about a
 * second before. Each of them is Neoxify answering, and the banner has to
 * hear of it as it hears of the API's own answers. In its own file so
 * egress.ts and updates.ts can say so without importing the API client. */

/** The JSON statuses an address that is not the backend has been seen
 * answering every request with. The backend gives them too -- an expired
 * token, a forbidden route, a missing one -- so one of them, alone, proves
 * neither that an address is the backend nor that it is not. Never counted
 * as having heard from Neoxify, wherever the answer was heard. */
export const DOUBTFUL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/** What a listener is told about an answer (`onBackendAnswer`). */
export interface BackendAnswer {
  /** Whether the answer could be one of a dashboard load's own: a request
   * sent through api.ts that only read -- the account, the plan, the
   * credentials, the server list, the health check a write's race sends
   * first -- or the token refresh, which any request may need before it is
   * sent. A dashboard's load is made of nothing else, so an answer like
   * this while one is under way is most likely that load's own; anything
   * else -- a claim, a renewal, a report, a release, a server switch, and
   * every answer heard outside api.ts -- was sent by something else. */
  read: boolean;
  /** Whether it was the egress check's `/health/ip`: a baseline, a rung's
   * proof, or the health poll every fifteen seconds while connected. As
   * much an answer from Neoxify as any, so the banner hears of it; but
   * asked on its own schedule, again and again, so a screen does not ask
   * for its load again for it. See `answerAsksAgain` in offline-retry.ts. */
  healthCheck?: true;
}

/** Who is told when the backend answers. See `onBackendAnswer`. */
const answerListeners = new Set<(answer: BackendAnswer) => void>();

/** Calls `listener` whenever Neoxify answers anything this app sends,
 * through any address, whatever the request was: through api.ts, its JSON
 * in any status but the doubtful ones, or a success with no body; the
 * updater's check, once it has completed; the egress check's `/health/ip`,
 * when it is the backend's JSON. Not a page from in front of it, which
 * says nothing about whether Neoxify was reached. Returns the function
 * that stops it.
 *
 * For a screen that has said Neoxify cannot be reached: the claim before
 * a connect, a report delivered, a renewal answered, a health check
 * through a tunnel -- any of them makes that untrue, and the screen has to
 * stop saying it then, not when its own next request happens to go out.
 * On the test VM the dashboard's banner went on saying "Can't reach
 * Neoxify" for a minute after the claim and the queued reports had been
 * answered through the tunnel (offline-retry.ts).
 *
 * The listener is told whether the answer could be a load's own, and
 * whether it was a health check (`BackendAnswer`). */
export function onBackendAnswer(listener: (answer: BackendAnswer) => void): () => void {
  answerListeners.add(listener);
  return () => {
    answerListeners.delete(listener);
  };
}

/** Tells every listener that Neoxify has answered. For the callers that
 * have established that it was Neoxify; see `onBackendAnswer` for what
 * counts. */
export function announceBackendAnswer(answer: BackendAnswer): void {
  for (const listener of [...answerListeners]) {
    try {
      listener(answer);
    } catch {
      // A screen's handler failing is no reason for the request to.
    }
  }
}

/** Whether one `/health/ip` answer, as the egress check's transport hands
 * it over (`HealthIpAnswer` in egress.ts), is the backend's own: a JSON
 * object, in any status but the doubtful ones -- what `servesBackend` in
 * api.ts counts for the API's own requests. Every address the check asks
 * is one of the API's (`apiEndpoints`), over TLS with one of our names,
 * so an object it parsed came from the backend through the panel, the CDN
 * or a mirror. An error page from in front of it is not JSON, and the
 * transport hands it over as no body. */
export function isBackendHealthAnswer(answer: { status: number; body: unknown }): boolean {
  const body = answer.body;
  return body !== null && typeof body === "object" && !Array.isArray(body) && !DOUBTFUL_STATUSES.has(answer.status);
}
