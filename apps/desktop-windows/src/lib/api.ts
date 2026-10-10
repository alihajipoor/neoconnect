import { fetch } from "@tauri-apps/plugin-http";
import { apiEndpoints, rememberedEndpoint, rememberEndpoint } from "./api-endpoints";
import { deviceHeaders } from "./device-identity";
import { maybeRefreshBundle } from "./endpoint-bundle-store";
import {
  clearDemotion,
  demotedLast,
  demoteEndpoint,
  knownOnBlockPage,
  resetDemotionsForTests,
  resolvesToBlockPage,
} from "./endpoint-demotion";
import { beginAttempt, failureOutcome, settleAttempt, type EndpointTrace, type TraceEntry } from "./endpoint-trace";
import { clearTokens, getTokens, setTokens } from "./session";
import { announceSessionRevoked } from "./session-revoked";
import type { TokenPair } from "./types";

/** How long one endpoint gets before the next is tried.
 *
 * The ladder had no timeout at all, and that turned the resilience work
 * into a slowdown for exactly the people it was for. Filtering in Iran
 * blackholes packets rather than refusing them, so a blocked endpoint
 * does not fail -- it hangs until the platform's own default gives up,
 * and every request on every screen paid that before reaching the one
 * that worked. Reported as "network error, and each page takes forever".
 *
 * Eight seconds is longer than any of these endpoints needs when it is
 * reachable, and short enough that walking the whole list stays within
 * what someone will sit through. It only costs anything on the first
 * request, since the winner is remembered.
 *
 * Walks only. A race gives every address `SLOW_ANSWER_MS`, because there
 * nobody waits on a slow address once another has answered.
 */
const ENDPOINT_TIMEOUT_MS = 8_000;

/** How long each address gets in a race for an answer worth waiting for:
 * a read's, the sign-in challenge's, a write's health race.
 *
 * Longer than `ENDPOINT_TIMEOUT_MS` because in a race nobody waits for a
 * slow address once another has answered, so a long deadline costs
 * something only when nothing answers at all. What it buys is the CDN
 * answering after nine to twenty seconds while every mirror is blocked:
 * at eight seconds that answer was thrown away, and the screen said it
 * could not reach a server that had in fact replied. That shape fits the
 * testers' reports, but it was modelled in a simulated network, not
 * observed on theirs.
 *
 * Reads were the last race still cut off at eight seconds -- the server
 * list, the account, the pre-connect config refresh -- so on that network
 * the location picker and the dashboard said Neoxify could not be reached
 * while the sign-in screen, given twenty, got through. What keeps a
 * longer deadline from making a blocked network slower to report is
 * `CONNECT_TIMEOUT_MS`: an address that never completes a connection is
 * given up on well before this. */
export const SLOW_ANSWER_MS = 20_000;

/** How long an address gets to complete a connection, passed to the HTTP
 * plugin with every request.
 *
 * reqwest applies it to everything before the request is sent: the name
 * lookup, the TCP handshake and the TLS handshake. A blackholed address,
 * which is what filtering in Iran usually makes of a blocked one, never
 * gets past the TCP handshake, so it fails here at ten seconds instead of
 * waiting out `SLOW_ANSWER_MS`. A race in which nothing at all is
 * reachable then ends at about ten seconds, not twenty, while an address
 * that did connect, and is merely slow to answer, keeps the full twenty.
 *
 * Ten seconds is a guess at the slowest handshake worth waiting for, not
 * a measurement: a TLS handshake throttled past ten seconds is cut off
 * by it, and so is the request. Whether that happens on the networks this
 * is for is unverified; the traces will show it as `timeout` at about
 * ten seconds (`failedAs`), and this is the number to change if they do.
 *
 * Ignored by the web portal, whose `fetch` is the browser's and has no
 * such setting: there an unreachable address takes the full deadline. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Sends one request to one address, with the connection deadline, and
 * notes who answered (`noteAnswer`).
 *
 * The options are put together in a variable rather than as a literal in
 * the call, because the web portal type-checks this file against the
 * browser's `fetch`, whose options have no `connectTimeout`; a literal
 * there would be rejected as an unknown property. */
async function send(base: string, path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const options: RequestInit & { connectTimeout: number } = { ...init, signal, connectTimeout: CONNECT_TIMEOUT_MS };
  const response = await fetch(`${base}${path}`, options);
  noteAnswer(base, response);
  return response;
}

/** Which address each response came from, for the one decision that
 * depends on it after the response has left the race or the walk: whether
 * a refused token refresh was refused by the backend (`refusedByBackend`). */
const answeredBy = new WeakMap<object, string>();

/** The addresses the backend has answered from in this run with something
 * other than a 401: JSON, of any other status. See `refusedByBackend` for
 * why a 401 does not count. */
const servedBackend = new Set<string>();

function noteAnswer(base: string, response: Response): void {
  // Whatever answered, the network let a request through to this
  // address, so it is no longer one to ask last (endpoint-demotion.ts).
  clearDemotion(base);
  // Tests stand responses in with plain objects; anything else cannot be
  // keyed, and there is nothing to note about it.
  if (typeof response !== "object" || response === null) return;
  answeredBy.set(response, base);
  if (isBackendAnswer(response) && response.status !== 401) servedBackend.add(base);
}

/** How a request that got no answer is recorded in the trace.
 *
 * `timedOut` is our own deadline. The plugin's connection deadline
 * (`CONNECT_TIMEOUT_MS`) is the other one, and it fails with the same
 * sentence as a reset or a refused connection, because reqwest's message
 * drops the cause. So a transport failure that lands at that deadline,
 * within the second after it, is taken to be it. Recorded as `net`
 * instead, every blackholed address would read as one that was refused,
 * which is the opposite diagnosis -- `timeout` is how a blackhole has
 * always read in these reports. A reset that happens to land in that same
 * second is recorded as a timeout; nothing else is. */
function failedAs(err: unknown, timedOut: boolean, startedAt: number): "timeout" | "scope" | "net" {
  if (timedOut) return "timeout";
  const outcome = failureOutcome(err);
  const elapsed = Date.now() - startedAt;
  return outcome === "net" && elapsed >= CONNECT_TIMEOUT_MS && elapsed < CONNECT_TIMEOUT_MS + 1_000 ? "timeout" : outcome;
}

/** Records an attempt at `base` that got no answer, and demotes the
 * address on this network if it timed out (endpoint-demotion.ts): a
 * timeout is what a blackholed address costs every race that asks it. A
 * name on the block page has been demoted already, by the lookup that
 * found it.
 *
 * For a failure, not for an attempt stopped because another address
 * answered or because the caller's own deadline ran out. Neither says
 * anything about this address. */
function settleFailure(
  entry: TraceEntry | undefined,
  base: string,
  outcome: ReturnType<typeof failedAs> | "blockpage",
): void {
  settleAttempt(entry, outcome);
  if (outcome === "timeout") demoteEndpoint(base);
}

/** How long the first address, the one that answered last time, has a
 * staggered race to itself before the others are asked -- and how long
 * those others then have before the addresses demoted on this network
 * are asked as well (`staggeredRace`).
 *
 * Every request in such a race is counted by the server, and the
 * sign-in challenge is throttled per address. Behind a node's mirror that
 * address is the node's, so every customer using that mirror shares one
 * bucket. Asking all eleven or more at once on every click would spend a
 * slot in every mirror's bucket, including mirrors other customers depend
 * on. Where the remembered address works, as it usually does, it answers
 * well inside this head start and nothing else is sent.
 *
 * Reads too. Every read used to go to every address at once, even with
 * the remembered one answering in eighty milliseconds: a VM counted 112
 * HTTPS connections for one launch of the app, seven reads to sixteen
 * addresses, each a fresh TCP and TLS handshake because the HTTP plugin
 * builds a new client for every request. On a throttled or metered
 * network that is traffic and time, and on a filtered one it is a burst
 * of handshakes to blocked names on every screen. With the head start,
 * the same launch opens seven where the remembered address works --
 * worked out from the code, not yet counted in the VM. Where it does not
 * work, a read waits this long before asking the rest, and only once:
 * the address that answers instead is remembered in its place. */
export const LEAD_MS = 1_500;

/** An address that has just answered, and how long the answer took. */
export interface AnsweredBase {
  base: string;
  /** From when the request was sent to when the response headers came back. */
  ms: number;
}

/** How long a follow-up gets at an address that has just answered.
 *
 * Never less than an ordinary walk gives anyone, and twice what the
 * address just took, so one that answered in fifteen seconds is given
 * time to answer again at the same pace instead of being cut off at
 * eight. Capped, because the address may have stopped answering since. */
function followUpTimeout(answered: AnsweredBase): number {
  return Math.min(SLOW_ANSWER_MS, Math.max(ENDPOINT_TIMEOUT_MS, 2 * answered.ms));
}

/** One address in a walk and how long it gets. */
interface Stop {
  base: string;
  timeoutMs: number;
}

/** How long a race winner is trusted to take a write without asking the
 * endpoints again.
 *
 * Long enough to cover what follows a read in the ordinary course of
 * things: the token refresh after a read's 401, a route switch after the
 * route list, a report after the screen that failed. Short enough that a
 * network change or a block that has just landed costs a write one
 * timeout at the old address, and then the health race (`sendWrite`). */
const PROVEN_FOR_MS = 60_000;

/** What a write asks the endpoints before it is sent, when no race has
 * found an answering address in the last `PROVEN_FOR_MS`. The backend's
 * health check: unauthenticated, small, stores nothing, and JSON from the
 * backend whatever it says -- a 503 from it saying the database is down
 * still proves the address reaches the backend. */
const HEALTH_PATH = "/health";

/** The last race in which the backend itself answered: where, how fast,
 * and when. Any race counts -- a read's, the sign-in challenge's, a
 * write's health race. */
let lastWinner: (AnsweredBase & { at: number }) | null = null;

function noteWinner(base: string, ms: number): void {
  lastWinner = { base, ms, at: Date.now() };
}

/** The last race winner, if it won within `PROVEN_FOR_MS`. */
function recentWinner(): AnsweredBase | null {
  if (lastWinner === null) return null;
  const age = Date.now() - lastWinner.at;
  // A clock set back is not a fresh answer.
  if (age < 0 || age >= PROVEN_FOR_MS) return null;
  return { base: lastWinner.base, ms: lastWinner.ms };
}

/** How long a walk gives an address it had not planned to try: the
 * pace it last won a race at, when it did, or else an ordinary walk's. */
function timeoutAt(base: string): number {
  return lastWinner !== null && lastWinner.base === base ? followUpTimeout(lastWinner) : ENDPOINT_TIMEOUT_MS;
}

/** Forgets the last race winner, which addresses the backend has
 * answered from, and which have been demoted, so one test's answers do
 * not decide where the next test's write is sent, whether its refused
 * refresh is believed, or which address its races ask first. */
export function resetRaceWinnerForTests(): void {
  lastWinner = null;
  servedBackend.clear();
  resetDemotionsForTests();
}

/** Statuses a proxy in front of the backend -- a node mirror's nginx,
 * the CDN -- uses for "I could not get you an answer": bad gateway,
 * unavailable, gateway timeout, and the CDN's own origin-unreachable
 * family. */
const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

/** Of those, the ones where the backend may have received the request,
 * and acted on it, without its answer getting back. A write is not sent
 * on to another endpoint after one of these: it may already have
 * happened, and a second copy of a purchase, a voucher redemption or a
 * registration is a duplicate row or a false "already done".
 *
 * Not only the timeouts (504, 524). A 502 is also what nginx sends when
 * the upstream closed the connection before answering -- a backend
 * container restarting mid-request during a deploy, or the hop from a
 * mirror to the panel reset part-way -- and the CDN's 520 is an origin
 * that returned something empty or unreadable. Neither says the request
 * never arrived. The rest (503, 521-523, 525, 526, 530) are refusals
 * before the backend was reached, and a write moves on after those --
 * as it does after any other page from in front of the backend
 * (`isForeignPage`), none of which got as far as the backend either. */
const MAY_HAVE_REACHED_BACKEND = new Set([502, 504, 520, 524]);

/** The writes that may go on to the next address even after a page that
 * says the backend may have been reached (`MAY_HAVE_REACHED_BACKEND`),
 * because a second copy reaching it does no harm.
 *
 * The token refresh only. The backend checks the token and the session it
 * names, marks that session used and hands back a new pair; the refresh
 * token is not used up, so a copy that did arrive, and whose answer was
 * lost on the way back, leaves nothing for a second one to collide with.
 * Stopping there instead told the customer the session could not be
 * renewed while another address would have renewed it. (A token from
 * before sessions existed is given a new session each time, so a second
 * copy leaves one unused session behind, which the backend drops once it
 * has been idle as long as a refresh token lives.)
 *
 * Not the sign-in, although a second copy of it creates nothing that
 * matters: it carries a single-use proof-of-work solution, so a copy sent
 * after one that did arrive is refused as a security check already used,
 * and that is what the customer would be shown about a sign-in that had
 * in fact gone through. Doing it properly needs a fresh challenge for the
 * second copy. Not anything that buys, redeems, registers or claims,
 * which `MAY_HAVE_REACHED_BACKEND` is there for. */
const REPEATABLE_WRITES = new Set(["/customer-auth/refresh"]);

/** Whether this response is a proxy's own failure page rather than an
 * answer from the backend.
 *
 * The backend's deliberate 503s are JSON (the health check, the
 * customer endpoints that say "try again"), and they are answers. A
 * proxy's are HTML or plain text. That difference is what keeps one
 * broken mirror from speaking for the service: it answers 502 in one
 * round trip -- faster than a healthy endpoint, because it never reaches
 * the backend -- and used to win every raced GET, get remembered, and
 * then lead every write, which stopped on it.
 *
 * One kind of `isForeignPage`, singled out for what it says about a
 * write: see `MAY_HAVE_REACHED_BACKEND`. */
export function isGatewayFailure(response: Response): boolean {
  if (!GATEWAY_STATUSES.has(response.status)) return false;
  return !isBackendAnswer(response);
}

/** Whether this response is the backend speaking.
 *
 * Every answer the backend gives is JSON, its refusals included. Pages
 * from whatever stands in front of it are not: a proxy's failure page, a
 * node's fallback site that has no `/api` location, the CDN's bot check.
 * Used only where a request's every answer is known to be JSON. */
function isBackendAnswer(response: Response): boolean {
  const type = response.headers?.get?.("content-type") ?? "";
  return type.toLowerCase().includes("application/json");
}

/** Whether this response is a page from whatever stands in front of the
 * backend, rather than the backend's own answer: an error status that is
 * not JSON.
 *
 * Every refusal the backend makes is JSON -- its validation errors, its
 * 401s, its throttle's 429s, its "try again" 503s, and its answer to a
 * path it does not have. An error page from anything else is not: a
 * proxy's failure page (`isGatewayFailure`), a node's fallback site that
 * has no `/api` location and answers 404, nginx refusing a request it
 * will not pass on, the CDN's bot check, which is a 403 page. Each of
 * them answers faster than the backend can, because it never reaches it.
 * While only the gateway pages were kept out of the race, a 403 or 404
 * page in fifty milliseconds won the server list and sign-in, was
 * remembered, led every write after it and ended them, and both screens
 * said "Request failed (404)" until that address stopped answering. That
 * was measured against a simulated network, not reported from the field.
 *
 * Such a page is never a race's winner, never remembered, never asked for
 * the address bundle, and never the end of a walk; it is kept only as the
 * answer of last resort, so that a request nothing better answered says
 * what did answer rather than "could not reach Neoxify".
 *
 * A success without JSON is not counted here. The backend's 204s and
 * 304s carry no body and no type at all. */
export function isForeignPage(response: Response): boolean {
  return response.status >= 400 && !isBackendAnswer(response);
}

/** Thrown for a write whose health race the backend answered, when the
 * write itself then got no answer anywhere it was sent. Neoxify was
 * reached moments earlier, so this is not "could not reach Neoxify". */
class StoppedAnswering extends Error {}

/** A walk over addresses, one at a time, carried across its stages. */
interface Walk {
  /** Every address this request has been sent to. None gets it twice. */
  tried: Set<string>;
  /** The first page from in front of the backend (`isForeignPage`), kept
   * in case nothing better answers. After one, the next endpoint is
   * tried -- except after a gateway page that says the backend may have
   * been reached (`MAY_HAVE_REACHED_BACKEND`), because a write must not be
   * sent twice, unless it is one that may (`REPEATABLE_WRITES`). */
  page: Response | null;
  lastError: unknown;
  /** The remembered endpoint as the walk last read it. */
  remembered: string | undefined;
}

/** `rememberedEndpoint`, which is advisory: a walk goes on without it. */
async function rememberedNow(): Promise<string | undefined> {
  try {
    return await rememberedEndpoint();
  } catch {
    return undefined;
  }
}

async function newWalk(): Promise<Walk> {
  return { tried: new Set(), page: null, lastError: undefined, remembered: await rememberedNow() };
}

/** Puts the remembered endpoint at the head of the walk if it has
 * changed since the walk last looked and has not been tried.
 *
 * A walk's list is fixed when it starts, and another request may find an
 * address that answers while this one is still waiting out a dead one.
 * Measured in a VM with every name but one sinkholed: the dashboard's
 * reads found the live address in under a second, and a report sent at
 * the same moment walked six other addresses at eight seconds each, 56
 * seconds in all, before reaching it. */
async function followRemembered(queue: Stop[], walk: Walk): Promise<void> {
  const remembered = await rememberedNow();
  if (remembered === undefined || remembered === walk.remembered) return;
  walk.remembered = remembered;
  if (walk.tried.has(remembered)) return;
  const at = queue.findIndex((stop) => stop.base === remembered);
  queue.unshift(at === -1 ? { base: remembered, timeoutMs: timeoutAt(remembered) } : queue.splice(at, 1)[0]);
}

/** Walks the given addresses, one at a time, and returns the first
 * answer -- or null when none of them gave one, leaving what the walk
 * found in `walk` for the next stage or the caller.
 *
 * The shape every request had before 0.9.39, kept for the ones that must
 * not be duplicated. "Answers" means the backend answered -- any status,
 * because a 401 is the server telling us the password was wrong and must
 * not send us looking for a mirror that says something nicer. A page from
 * in front of the backend (`isForeignPage`) is not the backend saying
 * anything: it is kept as the answer of last resort and the walk goes on,
 * unless it says the backend may already have acted on the write
 * (`MAY_HAVE_REACHED_BACKEND`). Then the walk ends there, as before,
 * except for a write that can safely be sent twice (`REPEATABLE_WRITES`).
 * Either way such a page is never remembered or asked for the bundle.
 *
 * Each stop carries its own timeout: an address that has just answered
 * is given time to answer at the pace it just showed (`followUpTimeout`).
 * Before each step the remembered endpoint is read again
 * (`followRemembered`), and an address no request had heard from when
 * the walk began is tried as soon as one has. An address already in
 * `walk.tried` is skipped: a write goes to each address once.
 */
async function fetchOneEndpointAtATime(
  path: string,
  init: RequestInit,
  stops: Stop[],
  walk: Walk,
  trace?: EndpointTrace,
): Promise<Response | null> {
  const queue = [...stops];
  // A caller's own signal, when it brought one. Each endpoint still gets
  // its own controller and timeout; the caller's only ever shortens that,
  // and once it has fired no further endpoint is tried. Without this a
  // request with a budget of its own -- the device-slot release, which
  // must be over in a second and a half -- walked every mirror at eight
  // seconds each regardless.
  const outer = init.signal ?? null;
  for (;;) {
    await followRemembered(queue, walk);
    if (outer?.aborted) break;
    const stop = queue.shift();
    if (stop === undefined) break;
    const { base, timeoutMs } = stop;
    if (walk.tried.has(base)) continue;
    walk.tried.add(base);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const startedAt = Date.now();
    const entry = beginAttempt(trace, base, startedAt);
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener("abort", onOuterAbort);
    try {
      const response = await send(base, path, init, controller.signal);
      settleAttempt(entry, `h${response.status}`);
      if (isForeignPage(response)) {
        // Never remembered and never asked for the bundle: it is not the
        // service. The CDN's 502 page used to be both, and then led every
        // write after it. A gateway page that may have come after the
        // backend acted still ends a write that must not be sent twice;
        // any other page is kept, and the next address is tried.
        if (MAY_HAVE_REACHED_BACKEND.has(response.status) && !REPEATABLE_WRITES.has(path)) return response;
        walk.page ??= response;
        continue;
      }
      void rememberEndpoint(base);
      void maybeRefreshBundle(base);
      return response;
    } catch (err) {
      // Stopped by the caller's deadline rather than failing: left
      // pending, which the trace renders as `budget`. Recording it as a
      // transport failure would say the network refused an address that
      // was simply still being waited for.
      if (timedOut || !outer?.aborted) settleFailure(entry, base, failedAs(err, timedOut, startedAt));
      walk.lastError = err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }
  return null;
}

/** What a walk that got no answer ends with. Something did answer, if
 * only a page from in front of the backend: then the caller gets its
 * status, never "could not reach Neoxify". Otherwise the walk's failure is
 * thrown. */
function unanswered(walk: Walk, init: RequestInit): Response {
  if (walk.page) return walk.page;
  throw walk.lastError ?? new Error(init.signal?.aborted ? "the request ran out of time" : "no API endpoint answered");
}

/** Sends a write -- anything but a plain read -- to one address at a
 * time, and only to addresses that have just answered.
 *
 * A write used to walk the whole list, eight seconds for every address
 * that did not answer, whatever the rest of the app had already found
 * out about this network. In a VM with every name but one sinkholed, a
 * POST took 56 seconds to reach the address the dashboard's reads had
 * found in under a second, and 134 to try all sixteen. Sign-in no longer
 * does that (`publicRace`); this is the same for every other write: the
 * token refresh, the social sign-in exchange, a route switch, an attempt
 * report, and the rest.
 *
 * First, the address a race last heard the backend from, if that was
 * within `PROVEN_FOR_MS` -- the usual case, since writes mostly follow
 * reads. Otherwise, or if that address does not answer, the endpoints not
 * yet tried are raced for the health check (`raceForHealth`), and the
 * write walks only those that answered it, in the order they answered,
 * each given time to answer at the pace it just showed. Throughout, the
 * remembered endpoint is read again before each step
 * (`followRemembered`).
 *
 * If none of those takes the write, the race is run again over the
 * addresses it has not yet heard from -- the ones stopped when the first
 * answer came in -- and so on until one takes it or nothing more answers.
 * An address that failed a health race, or has been sent the write, is
 * not asked again, so every round is smaller than the one before. Usually
 * there is one round: the address that answered the health check takes
 * the write.
 *
 * The write itself is still sent to one address at a time, and to each
 * at most once, for the reasons `fetchAnyEndpoint` gives. When nothing
 * answers the health race the write is not sent at all, and the result
 * is "could not reach Neoxify" after about twenty seconds at most --
 * eleven and a half where no address completes a connection
 * (`CONNECT_TIMEOUT_MS`), thirteen when some of them had been demoted
 * and are asked a head start later (`staggeredRace`) -- rather than
 * after a walk of the whole list.
 * When the backend answered it and then the write got no answer,
 * `StoppedAnswering` is thrown instead: Neoxify was reached moments
 * earlier. */
async function sendWrite(
  path: string,
  init: RequestInit,
  endpoints: string[],
  trace?: EndpointTrace,
): Promise<Response> {
  const outer = init.signal ?? null;
  const walk = await newWalk();
  // Addresses a health race may still ask.
  let candidates = [...endpoints];
  // Whether the backend itself answered a health race for this write.
  let reached = false;

  const recent = recentWinner();
  if (recent !== null) {
    const stop = { base: recent.base, timeoutMs: followUpTimeout(recent) };
    const response = await fetchOneEndpointAtATime(path, init, [stop], walk, trace);
    if (response) return response;
    // The last winner has just failed a write, unless the caller's own
    // deadline cut it short. It is no longer offered to the next one,
    // which would otherwise wait out the same timeout before asking.
    if (lastWinner?.base === recent.base && !outer?.aborted) lastWinner = null;
  }

  let stops: Stop[] = [];
  for (;;) {
    if (stops.length > 0) {
      const response = await fetchOneEndpointAtATime(path, init, stops, walk, trace);
      if (response) return response;
    }
    candidates = candidates.filter((base) => !walk.tried.has(base));
    if (candidates.length === 0 || outer?.aborted) break;
    const health = await raceForHealth(candidates, outer, trace);
    reached ||= health.backend;
    if (health.answered.length === 0) break;
    candidates = candidates.filter((base) => !health.silent.includes(base));
    stops = health.answered.map((answered) => ({ base: answered.base, timeoutMs: followUpTimeout(answered) }));
  }
  // A write cut off by its caller's own deadline was not left unanswered
  // by the backend: that is the caller's to say, as before.
  if (reached && !walk.page && !outer?.aborted) throw new StoppedAnswering();
  return unanswered(walk, init);
}

/** Sends one request, trying each known endpoint until one answers.
 *
 * "Answers" means a real HTTP response from the backend, whatever its
 * status. A 401 or a 500 proves the endpoint is reachable and is the
 * service -- moving on would be wrong, and would turn one rejected
 * password into a walk through every mirror. Only a transport failure,
 * which is what a blocked address looks like, rotates to the next -- and
 * a page from whatever stands in front of the backend (`isForeignPage`):
 * a proxy saying the backend could not be reached through it, a fallback
 * site, the CDN's bot check, none of them the backend saying anything.
 * Such a page is kept as the answer only if nothing better replies.
 *
 * Throws if none answered, so the callers below keep their existing
 * "could not reach Neoxify" handling unchanged -- or `StoppedAnswering`,
 * for a write the backend had just answered the health race for.
 *
 * `trace`, when given, is told about every address tried and how each
 * attempt ended -- see endpoint-trace.ts. It changes nothing about which
 * addresses are tried or for how long.
 *
 * `via`, when given, replaces the list: the request walks exactly those
 * addresses, in that order, one at a time, each with a timeout fitted to
 * how fast it has just answered. It is for a write that follows a race
 * (`publicRace`): the race has already found out which addresses answer
 * on this network, and walking the whole list again would spend another
 * eight seconds on every blocked address before reaching the one that
 * answered a moment ago. A write without `via` finds that out for itself
 * (`sendWrite`).
 */
async function fetchAnyEndpoint(
  path: string,
  init: RequestInit,
  trace?: EndpointTrace,
  via?: AnsweredBase[],
): Promise<Response> {
  const endpoints = via ? via.map((answered) => answered.base) : await apiEndpoints();
  if (endpoints.length === 0) throw new Error("no API endpoint is configured");
  // A caller whose deadline has already passed gets nothing sent on its
  // behalf, by any path below.
  if (init.signal?.aborted) throw new Error("the request ran out of time");
  if (via) {
    const stops = via.map((answered) => ({ base: answered.base, timeoutMs: followUpTimeout(answered) }));
    const walk = await newWalk();
    return (await fetchOneEndpointAtATime(path, init, stops, walk, trace)) ?? unanswered(walk, init);
  }

  // Raced, not walked.
  //
  // Each endpoint used to get its own ENDPOINT_TIMEOUT_MS of 8 seconds,
  // tried one after another, with the comment explaining that a single
  // hanging address must not consume the budget. The arithmetic went the
  // other way: the pre-connect config refresh wraps this in a 6 second
  // budget (REFRESH_BUDGET_MS), which is *shorter* than one endpoint's
  // timeout -- so if the first address did not answer, the budget
  // expired inside it and the rest were never tried at all. One blocked
  // address meant the refresh always failed. That much was real, and
  // read straight off the code.
  //
  // What this comment used to say next was not. It blamed that for
  // Windows reaching the API less often than Android -- "162
  // CONTROL_PLANE_UNREACHABLE reports from Windows in thirty days" --
  // and explained the difference by the mobile build having no seed
  // bundle. The "Windows" rows were the mobile app's iOS builds, which
  // the shared attempts.ts labelled "windows" until 0.2.22: every one
  // carries a 0.2.x version, and the real Windows client had recorded
  // none. The arithmetic bit the mobile app before 0.2.22.
  //
  // The seed half is open, and for iOS only. Since 4174b7c the Android
  // and Windows release workflows refuse to build without the seed
  // (NEOXIFY_REQUIRE_SEED). The iOS builds, 0.2.18 to 0.2.21, were made
  // on the Mac, where nothing required it until build-ios.sh did on
  // this branch: a failed fetch there would have baked in the
  // placeholder, and with it a capability scope naming only the one
  // compiled-in domain -- the one blocked in Iran -- so every other
  // address would be refused on the device. Whether any shipped IPA was
  // built that way is not known; it is the leading candidate for the
  // iOS builds' unreachable rate, and docs/windows-service-rewrite.md
  // ("What this does not fix") says how to check it.
  //
  // Racing removes the arithmetic entirely. The slowest address costs
  // nothing because nobody waits for it, and the result arrives in one
  // round trip -- after the first address's head start, when it is not
  // the one that answers -- rather than after however many dead addresses
  // precede the live one. Raced only when racing is safe, which means only
  // when the request can be sent more than once without the server
  // minding.
  //
  // A race may send the request to every mirror. For a config GET that is
  // the point, where the remembered address does not answer: then the
  // rest are asked a head start later (`staggeredRace`). For a sign-in it
  // means one click becomes eleven login attempts, and that breaks login
  // in two ways at once. The proof-of-work challenge is single-use, so
  // the first request to arrive spends it and the server answers the rest
  // with 400 "this security check was already used" -- refused before any
  // password hashing, so those 400s come back *faster* than the one real
  // answer and win the race. And the endpoint is throttled at five
  // attempts a minute per address, so a single click is already over
  // budget and starts collecting 429s.
  //
  // So anything that is not a plain read goes to one endpoint at a
  // time, which is what 0.9.38 did for every request and what sign-in
  // has always needed. A blocked address still steps to the next one; it
  // is only the simultaneity that is withdrawn, and only where it was
  // never safe. Which addresses the write is walked over, and in what
  // order, is `sendWrite`'s to decide.
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return await sendWrite(path, init, endpoints, trace);

  // Won by any answer that is not a page from in front of the backend
  // (`isForeignPage`): the backend's JSON, whatever its status, and the
  // bodiless 204s and 304s it sends with no type at all.
  const { winner, answers, stop } = await staggeredRace(
    endpoints,
    path,
    init,
    (answer) => !isForeignPage(answer.response),
    trace,
  );
  if (winner) {
    stop(winner);
    return winner.response;
  }
  // Nothing but pages from in front of the backend answered. The first of
  // them is the answer -- the caller sees "Request failed (502)" or
  // "(403)" with a status, because something did reply -- and it was
  // neither remembered nor asked for the bundle: it is not the service.
  const kept = answers[0];
  stop(kept);
  if (kept !== undefined) return kept.response;
  // Thrown so the callers keep their "could not reach Neoxify" handling;
  // which address failed how is the trace's to say.
  throw new Error(init.signal?.aborted ? "the request ran out of time" : "no API endpoint answered");
}

/** The failure half of every result shape below.
 *
 * Named because two result unions share it verbatim, and a caller that
 * has narrowed on `ok === false` must read the same way whichever
 * request function produced it. */
export type RequestFailure = {
  ok: false;
  error: string;
  sessionExpired?: boolean;
  /** The HTTP status, when the server answered at all. Absent for a
   * transport failure, which is the distinction the token refresh needs:
   * a refusal ends the session, a request that never arrived must not. */
  status?: number;
  /** True only when no endpoint gave any HTTP answer: the request failed
   * in transport everywhere it was sent. The one failure that may be
   * described as "could not reach Neoxify" -- or, when the backend had
   * answered this sign-in's challenge or this write's health race moments
   * before, as having stopped responding (`STOPPED_ANSWERING`).
   *
   * Absent is not the opposite. A 401 whose token refresh could not be
   * completed has no `status` either, and the server did answer that
   * request; so does a thrown error nobody classified. Read absent as
   * "not known to have gone unanswered". */
  noResponse?: true;
  /** The server's machine-readable `code`, when its answer carried one
   * (`DEVICE_LIMIT`, `TAKEOVER_LIMIT`, ...).
   *
   * Kept because the message alone cannot carry it: every failure used
   * to be reduced to a sentence, and a device-limit refusal then read
   * exactly like any other error -- or, worse, like a reason to sign the
   * customer out. A 409 is neither. */
  code?: string;
  /** The parsed error body, present only alongside `code`, for the few
   * callers whose refusal carries data the screen needs (who is holding
   * the plan's devices, how long until a takeover is allowed again).
   * Untrusted shape: read it defensively. */
  body?: unknown;
};

export type ApiResult<T> = { ok: true; data: T } | RequestFailure;

/** The one sentence a transport failure is allowed to produce.
 *
 * A fresh object each time rather than a shared constant, so a caller
 * that stashes a result can never mutate the message every other caller
 * is about to read. */
const unreachable = (): RequestFailure => ({
  ok: false,
  error: "Could not reach Neoxify. Check your internet connection.",
  noResponse: true,
});

/** What a request says when Neoxify answered moments earlier -- the
 * sign-in challenge, or a write's health race -- and then nothing
 * answered the request itself.
 *
 * Not "could not reach Neoxify": it was reached, so the customer's
 * connection was working then. Saying otherwise would send them to check
 * a connection that may well be fine. The result still carries
 * `noResponse`, because this request got no answer, and is reported as
 * an unreachable control plane. */
export const STOPPED_ANSWERING = "Neoxify answered but then stopped responding. Please try again.";

/** The failure for a request that got no answer: see `StoppedAnswering`. */
function unansweredFailure(err: unknown): RequestFailure {
  return err instanceof StoppedAnswering ? { ok: false, error: STOPPED_ANSWERING, noResponse: true } : unreachable();
}

/** A refusal, in full: the sentence, the status, and the code.
 *
 * The body is read once and every part of the answer is kept. Reading it
 * only for its message is what made a 409 indistinguishable from any
 * other failure to every caller. */
async function failureFrom(res: Response): Promise<RequestFailure> {
  const body: unknown = await res.json().catch(() => null);
  const fields = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const message = fields?.message;
  const error = Array.isArray(message)
    ? message.join(", ")
    : typeof message === "string"
      ? message
      : `Request failed (${res.status})`;
  const code = typeof fields?.code === "string" ? fields.code : undefined;
  // The body travels only with a coded refusal, which is the only kind
  // whose fields anyone reads; a plain error is its sentence and status.
  return { ok: false, error, status: res.status, ...(code !== undefined ? { code, body } : {}) };
}

/** Unauthenticated request -- login/register don't have a token yet.
 *
 * `trace` records which addresses were tried; see endpoint-trace.ts.
 * `via` sends it only to addresses a race has just heard from; see
 * `fetchAnyEndpoint`. */
export async function publicRequest<T>(
  path: string,
  init?: RequestInit,
  trace?: EndpointTrace,
  via?: AnsweredBase[],
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetchAnyEndpoint(
      path,
      {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      },
      trace,
      via,
    );
  } catch (err) {
    return unansweredFailure(err);
  }

  if (!res.ok) {
    return await failureFrom(res);
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: (await res.json()) as T };
}

/** What a race found: the answer, and who else answered. */
export interface Raced<T> {
  result: ApiResult<T>;
  /** Every address that gave an HTTP answer, in the order a follow-up
   * should try them: the one whose answer became `result` first, then
   * the backend's other answers, then pages from whatever stands in front
   * of it. Empty only when nothing answered at all, which is also the
   * only time `result` says Neoxify could not be reached. */
  answered: AnsweredBase[];
}

/** One address's answer in a race. */
interface RaceAnswer {
  base: string;
  /** Its place in the order the race asked in, for stopping the rest. */
  i: number;
  response: Response;
  ms: number;
  backend: boolean;
}

/** How a staggered race ended. */
interface Staggered {
  /** The first answer the race's rule accepts, or null. */
  winner: RaceAnswer | null;
  /** Every answer, in the order it arrived. */
  answers: RaceAnswer[];
  /** The addresses that failed without an answer: refused, timed out,
   * unreachable. Not those stopped because the race was decided, and not
   * those the race was decided without asking. */
  failed: string[];
  /** Stops every request still running, except `spare`'s, whose body the
   * caller is about to read. */
  stop(spare?: RaceAnswer): void;
}

/** The stages a race over `count` addresses asks them in, as [from, to)
 * ranges of its order, when the first `healthy` of them have not been
 * demoted: the first address alone; the rest of those not demoted; the
 * demoted. Empty stages are left out, so with nothing demoted, or nothing
 * but the first address undemoted, there are two. */
function stagesOf(count: number, healthy: number): [number, number][] {
  const stages: [number, number][] = [];
  let from = 0;
  for (const to of [1, healthy, count]) {
    if (to > from) {
      stages.push([from, to]);
      from = to;
    }
  }
  return stages;
}

/** Sends one request to the endpoints as a staggered race.
 *
 * In stages (`stagesOf`). The address that answered last time goes
 * first, alone, for `LEAD_MS`. If it has not answered by then, or has
 * failed already, the other addresses are asked too -- except those
 * demoted on this network (endpoint-demotion.ts), which are asked
 * `LEAD_MS` after that, or as soon as everything asked before them has
 * failed. Demotion also decides the first: an address that has timed out
 * on this network in the last half hour, or whose name was found on the
 * block page, does not lead, even if it was the last to answer. Each
 * address gets `SLOW_ANSWER_MS` from when it is
 * asked. The race is won by the first answer `wins` accepts; it ends
 * without a winner when every address has settled, or when the caller's
 * signal fires.
 *
 * What the stages cost: where the remembered address works, nothing --
 * nobody else is asked. Where only a demoted address answers, up to two
 * head starts before it is asked; that is the price of not asking the
 * dead ones every time, and it is paid only until that address answers,
 * which lifts its demotion. A race nothing answers ends no later than
 * `2 * LEAD_MS + SLOW_ANSWER_MS`.
 *
 * An address whose name resolves to Iran's block page holds up nothing.
 * As each address is asked, its name's DNS answer is looked at too
 * (`resolvesToBlockPage`), and a request whose name turns out to resolve
 * to the block page and nothing else is stopped there and counted as
 * failed, so the next stage need not wait out the head start on it. A
 * name already found there in the last minute is not sent the request
 * at all. Either way the name is demoted on this network.
 *
 * A winner is remembered, and asked for the address bundle. One that is
 * the backend's own JSON is also offered to the next write (`sendWrite`);
 * a success with no body, which can win a read, says less about where a
 * write will be answered. */
async function staggeredRace(
  endpoints: string[],
  path: string,
  request: RequestInit,
  wins: (answer: RaceAnswer) => boolean,
  trace?: EndpointTrace,
): Promise<Staggered> {
  const { ordered, healthy } = demotedLast(endpoints);
  // With nothing to ask there is no stage to settle the race; every
  // caller checks first, and this keeps one that did not from waiting for
  // ever.
  if (ordered.length === 0) return { winner: null, answers: [], failed: [], stop: () => undefined };
  const stages = stagesOf(ordered.length, healthy);
  const outer = request.signal ?? null;
  const controllers = ordered.map(() => new AbortController());
  // Which aborts were our own deadline, so the trace can say "timeout"
  // rather than the generic transport failure the abort surfaces as.
  const timedOut = ordered.map(() => false);
  // Which were stopped, or never sent, because the name resolves to the
  // block page.
  const blockPage = ordered.map(() => false);
  // Which have answered or failed, so a lookup that comes back after
  // either leaves them be.
  const done = ordered.map(() => false);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const entries: (TraceEntry | undefined)[] = [];
  const answers: RaceAnswer[] = [];
  const failed: string[] = [];
  let settled = 0;
  // How many addresses have been asked, which is always a whole number of
  // stages, and which stage is next.
  let asked = 0;
  let stage = 0;
  let stageTimer: ReturnType<typeof setTimeout> | undefined;

  let decided = false;
  let decide: (winner: RaceAnswer | null) => void = () => undefined;
  const decision = new Promise<RaceAnswer | null>((resolve) => {
    decide = (winner) => {
      if (decided) return;
      decided = true;
      resolve(winner);
    };
  });

  const launch = (i: number) => {
    const base = ordered[i];
    const startedAt = Date.now();
    entries[i] = beginAttempt(trace, base, startedAt);
    // Each address gets `SLOW_ANSWER_MS`, and not a walk's eight seconds:
    // an answer that took longer than eight seconds used to be thrown away
    // by the read race, and the screen said Neoxify could not be reached.
    // An address that cannot even connect still drops out at
    // `CONNECT_TIMEOUT_MS`.
    timers.push(
      setTimeout(() => {
        timedOut[i] = true;
        controllers[i].abort();
      }, SLOW_ANSWER_MS),
    );
    // Its name's DNS answer, looked at beside the request: the block page
    // stops it, and one found there in the last minute means it is not
    // sent at all.
    if (knownOnBlockPage(base)) blockPage[i] = true;
    else
      void resolvesToBlockPage(base).then((found) => {
        if (!found || done[i] || decided) return;
        blockPage[i] = true;
        controllers[i].abort();
      });
    // Started inside a promise, so a fetch that throws rather than
    // rejecting is still one address failing, not the whole race.
    void Promise.resolve()
      .then(() => {
        if (blockPage[i]) throw new Error("on the block page");
        return send(base, path, request, controllers[i].signal);
      })
      .then(
        (response) => {
          done[i] = true;
          settleAttempt(entries[i], `h${response.status}`);
          const answer: RaceAnswer = {
            base,
            i,
            response,
            ms: Date.now() - startedAt,
            backend: isBackendAnswer(response),
          };
          answers.push(answer);
          if (wins(answer)) decide(answer);
        },
        (err: unknown) => {
          done[i] = true;
          const outcome = blockPage[i] ? "blockpage" : failedAs(err, timedOut[i], startedAt);
          if (!decided) {
            failed.push(base);
            settleFailure(entries[i], base, outcome);
            return;
          }
          // After the decision: stopped because the race was decided, or
          // by the caller's deadline, which is not a failure and demotes
          // nothing -- even when it lands just past the connection
          // deadline, where the plugin's words for a cancelled request and
          // for a connection given up on are the same. `stop` has already
          // marked the first `cancel`; the second is left pending, which
          // the trace renders as `budget`.
          if (timedOut[i] || !outer?.aborted) settleAttempt(entries[i], outcome);
        },
      )
      .finally(() => {
        settled += 1;
        if (decided) return;
        if (settled === ordered.length) decide(null);
        // Everything asked so far has failed. Nothing is gained by keeping
        // the next stage waiting out the rest of its head start.
        else if (settled === asked) askNextStage();
      });
  };

  const askNextStage = () => {
    clearTimeout(stageTimer);
    if (decided || stage === stages.length) return;
    const [from, to] = stages[stage];
    stage += 1;
    asked = to;
    for (let i = from; i < to; i += 1) launch(i);
    if (stage < stages.length) stageTimer = setTimeout(askNextStage, LEAD_MS);
  };

  // The caller's signal stops every request at once, and one that has
  // already fired asks nobody. See `fetchOneEndpointAtATime` for why a
  // caller may bring one.
  const onOuterAbort = () => {
    decide(null);
    controllers.forEach((c) => c.abort());
  };
  outer?.addEventListener("abort", onOuterAbort);
  if (outer?.aborted) onOuterAbort();

  askNextStage();

  const winner = await decision;
  clearTimeout(stageTimer);
  // Timers only, and not the winner's controller. Aborting every
  // controller once the race was decided is what broke login in 0.9.39:
  // the winner was aborted along with the losers while its body was still
  // unread. A race resolves when the headers arrive, not when the body
  // does, so the caller's `response.json()` was left waiting on a stream
  // that had just been cancelled. The sign-in button sat on "Signing
  // in..." for ever and nginx recorded 499 for the winning request as
  // well as the losing ones, because the client had indeed hung up first.
  // The losers are stopped by the caller (`stop`), which knows which
  // answer it is about to read.
  timers.forEach(clearTimeout);
  // Detached for the same reason: a caller's signal firing after the
  // answer is in hand must not cancel a body still being read.
  outer?.removeEventListener("abort", onOuterAbort);

  if (winner) {
    // Remembered so the next request starts here and need ask nobody
    // else. The address bundle is asked for too: this is the only trigger
    // it has, and without it a published rotation never reaches a single
    // client.
    void rememberEndpoint(winner.base);
    if (winner.backend) noteWinner(winner.base, winner.ms);
    void maybeRefreshBundle(winner.base);
  }

  const stop = (spare?: RaceAnswer) => {
    controllers.forEach((c, i) => {
      if (i === spare?.i) return;
      // "cancel" only when somebody won, and marked before the abort
      // lands, so the trace does not read as a failure of an address that
      // may have been about to answer. Without a winner everything has
      // settled already, or the caller's deadline stopped it, which is
      // `budget`. An address never asked has no entry to mark.
      if (winner) settleAttempt(entries[i], "cancel");
      c.abort();
    });
  };
  return { winner, answers, failed, stop };
}

/** Every address that answered a race, in the order a follow-up should
 * try them: the winner first, then the backend's other answers, then
 * pages from whatever stands in front of it. Each once. */
function answeredInOrder(winner: RaceAnswer | null, answers: RaceAnswer[]): AnsweredBase[] {
  const ordered = [
    ...(winner ? [winner] : []),
    ...answers.filter((answer) => answer.backend && answer !== winner),
    ...answers.filter((answer) => !answer.backend),
  ];
  const answered: AnsweredBase[] = [];
  for (const answer of ordered) {
    if (!answered.some((a) => a.base === answer.base)) answered.push({ base: answer.base, ms: answer.ms });
  }
  return answered;
}

/** Sends one unauthenticated request to the endpoints as a staggered
 * race (`staggeredRace`), and reports who answered as well as what the
 * answer was.
 *
 * Only for a request that the server does not mind receiving more than
 * once -- nothing stored, nothing spent, beyond the throttle's count --
 * and whose every answer is JSON. The sign-in challenge is the reason
 * this exists. It is minted, signed and handed back without the server
 * keeping any record of it, so racing it is safe, where racing the
 * sign-in itself never was (see `fetchAnyEndpoint`).
 *
 * The race is won by the first answer from the backend itself
 * (`isBackendAnswer`), with one exception: a 429. The throttle counts
 * per address, and behind a mirror that is the node's address, so one
 * mirror being over its limit says nothing about the next one. A 429 is
 * kept as an answer, and the race goes on for one that is not. A page
 * from something in front of the backend never wins, for the reason
 * `isForeignPage` gives. If nothing better arrives, the first 429, or
 * failing that the first page, is the result, because something did
 * answer.
 *
 * The rest are stopped as soon as the winner is in.
 */
export async function publicRace<T>(path: string, init: RequestInit, trace?: EndpointTrace): Promise<Raced<T>> {
  const endpoints = await apiEndpoints();
  if (endpoints.length === 0 || init.signal?.aborted) return { result: unreachable(), answered: [] };
  const request: RequestInit = {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  };

  const { winner, answers, stop } = await staggeredRace(
    endpoints,
    path,
    request,
    (answer) => answer.backend && answer.response.status !== 429,
    trace,
  );

  // The answer that becomes the result: the winner, or failing that the
  // first 429, or failing that the first page.
  const kept = winner ?? answers.find((answer) => answer.backend) ?? answers[0];
  stop(kept);
  if (kept === undefined) return { result: unreachable(), answered: [] };
  return {
    result: await resultFrom<T>(kept.response, kept.backend),
    answered: answeredInOrder(winner, answers),
  };
}

/** Races the health check across `endpoints`, for a write about to be
 * sent (`sendWrite`): who answered, in answer order; whether the backend
 * itself was among them; and who failed to answer at all, which a later
 * round need not ask again.
 *
 * Won by the first answer from the backend, whatever its status. Unlike
 * the sign-in challenge, nothing is wanted from the answer but the fact
 * of it, and a 429 or a 503 from the backend proves the address reaches
 * it as well as a 200 does. A page from in front of the backend does not
 * win, but is still listed, last: something answered there, and if
 * nothing better does, the write collects that status rather than "could
 * not reach Neoxify".
 *
 * Traced under its own phase, `health`, and the caller's phase put back
 * after. Every request is stopped once the race is decided; no body is
 * read. */
async function raceForHealth(
  endpoints: string[],
  signal: AbortSignal | null,
  trace?: EndpointTrace,
): Promise<{ answered: AnsweredBase[]; backend: boolean; silent: string[] }> {
  const phase = trace?.phase;
  if (trace) trace.phase = "health";
  try {
    const { winner, answers, failed, stop } = await staggeredRace(
      endpoints,
      HEALTH_PATH,
      { method: "GET", signal },
      (answer) => answer.backend,
      trace,
    );
    stop();
    return {
      answered: answeredInOrder(winner, answers),
      backend: winner !== null,
      silent: failed,
    };
  } finally {
    if (trace && phase !== undefined) trace.phase = phase;
  }
}

/** The result a raced answer stands for. A page from in front of the
 * backend is never a success, whatever its status: a node's fallback site
 * can answer 200 with HTML to any path. */
async function resultFrom<T>(res: Response, backend: boolean): Promise<ApiResult<T>> {
  if (!res.ok || !backend) return await failureFrom(res);
  if (res.status === 204) return { ok: true, data: undefined as T };
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, error: `Request failed (${res.status})`, status: res.status };
  }
}

/** The status with which the server says this refresh token is no good.
 *
 * `customer-auth.service.ts` answers 401 for both of its refusals --
 * a token that does not verify and one whose version was revoked -- and
 * only that ends the session. Everything else says nothing about the
 * token: a 429 from the throttle, a 5xx, a 403 from a CDN's bot check, a
 * request that never arrived. Every one of those used to sign the
 * customer out, and now that signing out takes the tunnel down it would
 * also disconnect somebody because a network in Iran dropped one
 * request. And a 401 ends it only when it is the backend's: see
 * `refusedByBackend`. */
const REFRESH_REFUSED = 401;

/** Whether a 401 to the token refresh is the backend refusing the token,
 * which ends the session and takes the tunnel down with it.
 *
 * Only a JSON 401, which is how the backend says it, and only from an
 * address the backend has answered from with something other than a 401
 * (`servedBackend`). A page from in front of the backend can say 401 too
 * -- a node's fallback site, anything at a mirror's address that is not
 * our API -- and it answers faster than the backend, so it could win the
 * read and then be sent the refresh. A simulated network showed both an
 * HTML and a JSON 401 from one broken address signing the customer out
 * that way. A 401 is not counted as having heard from the backend, because
 * an address that answers 401 to everything is exactly the one in doubt.
 *
 * An address the backend has not otherwise answered from in this run is
 * asked for the health check, once, before its 401 is believed. That is
 * what happens when the app starts with an expired access token and a
 * revoked session: the refusal is real, and nothing but 401s has been
 * heard from anywhere yet. The health check is public, so a 401 to it is
 * not the backend's either.
 *
 * What this does not do is find the backend elsewhere. An address that
 * answers JSON 401 to everything still wins every read it answers first,
 * and each of those reads ends with "could not renew your session"; the
 * customer is not signed out, and the tunnel stays up. */
async function refusedByBackend(res: Response, trace?: EndpointTrace): Promise<boolean> {
  if (res.status !== REFRESH_REFUSED || !isBackendAnswer(res)) return false;
  const base = answeredBy.get(res);
  if (base === undefined) return false;
  if (servedBackend.has(base)) return true;
  await askForHealth(base, trace);
  return servedBackend.has(base);
}

/** Sends the health check to one address and waits for the headers. The
 * answer is noted by `send` like any other; nothing else is done with it.
 * Traced under `health`, with the caller's phase put back after. */
async function askForHealth(base: string, trace?: EndpointTrace): Promise<void> {
  const phase = trace?.phase;
  if (trace) trace.phase = "health";
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutAt(base));
  const startedAt = Date.now();
  const entry = beginAttempt(trace, base, startedAt);
  try {
    const response = await send(base, HEALTH_PATH, { method: "GET" }, controller.signal);
    settleAttempt(entry, `h${response.status}`);
  } catch (err) {
    settleFailure(entry, base, failedAs(err, timedOut, startedAt));
  } finally {
    clearTimeout(timer);
    // The body is not wanted.
    controller.abort();
    if (trace && phase !== undefined) trace.phase = phase;
  }
}

type Refresh =
  | { kind: "renewed"; tokens: TokenPair }
  /** The server refused the refresh token: the session is over. */
  | { kind: "refused" }
  /** Nothing stored to refresh -- already signed out, which is not news. */
  | { kind: "none" }
  /** The refresh could not be completed; the session may well be fine. */
  | { kind: "unavailable" };

async function refreshTokens(trace?: EndpointTrace): Promise<Refresh> {
  const current = await getTokens();
  if (!current) return { kind: "none" };

  // Sent through `fetchAnyEndpoint` rather than `publicRequest`, so the
  // response is still in hand to say where a refusal came from.
  let res: Response;
  try {
    res = await fetchAnyEndpoint(
      "/customer-auth/refresh",
      {
        method: "POST",
        body: JSON.stringify({ refreshToken: current.refreshToken }),
        headers: {
          "Content-Type": "application/json",
          // What this device is called on the customer's other devices
          // ("Neoxify is in use on a Windows PC"). Sent on every refresh
          // because a session started in the system browser could not send
          // it, and its first refresh is what names that device. See
          // device-identity.ts.
          ...deviceHeaders(),
        },
      },
      trace,
    );
  } catch {
    return { kind: "unavailable" };
  }
  if (await refusedByBackend(res, trace)) return { kind: "refused" };

  // A page from in front of the backend is never a new pair of tokens,
  // whatever its status.
  const result = await resultFrom<TokenPair>(res, isBackendAnswer(res));
  if (!result.ok) return { kind: "unavailable" };
  await setTokens(result.data);
  return { kind: "renewed", tokens: result.data };
}

/** Either a real HTTP response, or a failure already phrased for the
 * customer. Deliberately not an `ApiResult`: the status still has to be
 * interpreted, and each caller below interprets it differently. */
type Attempt = { answered: true; res: Response } | { answered: false; failure: RequestFailure };

/** Everything an authenticated request does *around* the response:
 * attach the stored access token, and on a 401 (expired access token,
 * the normal case ~every 15 minutes) try exactly one silent
 * refresh-and-retry before giving up. If the server refuses the refresh
 * (revoked/expired refresh token), clear the stored session, report
 * `sessionExpired: true` so the UI can drop back to the login screen
 * instead of showing a raw error, and announce it so the app ends the
 * session -- tunnel included -- whichever screen asked. A refresh that
 * merely failed to complete does none of that.
 *
 * Split out from `apiRequest` so a second interpretation of the
 * response -- conditional requests, below -- cannot drift from this one.
 * Every failure mode is a `RequestFailure` here rather than a thrown
 * error, so no caller can accidentally let one pass as success.
 *
 * With a `trace`, each leg is recorded under its own phase -- the
 * request, the token refresh, the retry -- because which of them a
 * failure happened in is the first thing to know about it. */
async function authenticatedAttempt(path: string, init?: RequestInit, trace?: EndpointTrace): Promise<Attempt> {
  const tokens = await getTokens();
  if (!tokens) {
    return { answered: false, failure: { ok: false, error: "Not signed in.", sessionExpired: true } };
  }

  const doFetch = (accessToken: string) =>
    fetchAnyEndpoint(
      path,
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...init?.headers,
        },
      },
      trace,
    );

  let res: Response;
  try {
    if (trace) trace.phase = "req";
    res = await doFetch(tokens.accessToken);
  } catch (err) {
    return { answered: false, failure: unansweredFailure(err) };
  }

  // The backend's 401 only. A 401 page from something in front of it is
  // the answer of last resort -- nothing better replied -- and says
  // nothing about this session's tokens; it is returned as it is.
  if (res.status === 401 && isBackendAnswer(res)) {
    if (trace) trace.phase = "refresh";
    const refreshed = await refreshTokens(trace);
    if (refreshed.kind === "unavailable") {
      // Not a verdict on the session, so neither the tokens nor the
      // screen change. The next request tries the refresh again.
      return {
        answered: false,
        failure: { ok: false, error: "Could not renew your session just now. Try again in a moment." },
      };
    }
    if (refreshed.kind !== "renewed") {
      await clearTokens();
      // Told to the app as a whole, not only to this caller -- most
      // callers would otherwise drop it. Not for `none`: that is a
      // request from a session that has already ended, finishing late,
      // and announcing it would put "your session ended" over a sign-in
      // screen the customer reached by signing out.
      if (refreshed.kind === "refused") announceSessionRevoked();
      return {
        answered: false,
        failure: { ok: false, error: "Your session expired. Please sign in again.", sessionExpired: true },
      };
    }
    try {
      if (trace) trace.phase = "retry";
      res = await doFetch(refreshed.tokens.accessToken);
    } catch (err) {
      return { answered: false, failure: unansweredFailure(err) };
    }
  }

  return { answered: true, res };
}

/** Authenticated request. See `authenticatedAttempt` for the token and
 * refresh handling; this adds the body.
 *
 * A refusal keeps its status and code. Only a 401 whose refresh the
 * server refused is a sign-out (`sessionExpired`); a 409 is an answer,
 * and the caller decides what it means. */
export async function apiRequest<T>(path: string, init?: RequestInit, trace?: EndpointTrace): Promise<ApiResult<T>> {
  const attempt = await authenticatedAttempt(path, init, trace);
  if (!attempt.answered) return attempt.failure;
  const res = attempt.res;

  if (!res.ok) {
    return await failureFrom(res);
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: (await res.json()) as T };
}

/** The ETag off a response, or null if there isn't one.
 *
 * `Headers.get` is case-insensitive, so the header's casing on the wire
 * does not matter. The optional chaining is for the response object
 * being duck-typed in tests, not for anything reqwest does. */
function readEtag(res: Response): string | null {
  return res.headers?.get("ETag") ?? null;
}

/** The result of a conditional request.
 *
 * A separate union rather than a widening of `ApiResult<T>`: ~30 call
 * sites narrow on `ok` and then read `data`, and a `data`-less success
 * would make every one of them a potential undefined. The failure half
 * is the same `RequestFailure`, so a caller that only cares whether it
 * worked reads identically. */
export type Revalidated<T> =
  | { ok: true; notModified: true; etag: string | null }
  | { ok: true; notModified: false; data: T; etag: string | null }
  | RequestFailure;

/** Authenticated GET that offers the server a validator, so an unchanged
 * answer costs a 304 with no body instead of the whole payload.
 *
 * Opt-in, and separate from `apiRequest`, because it only pays off where
 * the caller is holding the previous body to pair with a 304 -- without
 * that, a 304 is not a cache hit, it is an answer with nothing in it.
 *
 * The tag is echoed back byte for byte: exactly one value, no list, and
 * no stripping of the `W/` prefix. The server compares the whole
 * `If-None-Match` header with `===` against the tag it minted, so any
 * reshaping here silently turns every revalidation back into a full
 * download -- which would still be *correct*, and would therefore never
 * show up as a failure anywhere. */
export async function apiRequestRevalidated<T>(path: string, etag: string | null): Promise<Revalidated<T>> {
  const validator = etag && etag.length > 0 ? etag : null;
  const init: RequestInit | undefined = validator ? { headers: { "If-None-Match": validator } } : undefined;

  const attempt = await authenticatedAttempt(path, init);
  if (!attempt.answered) return attempt.failure;
  const res = attempt.res;

  // Before the `!res.ok` branch: `Response.ok` is false for 304, so
  // reading it as an error is exactly what the unconditional path does
  // today, and it turns a cache hit into "Request failed (304)".
  //
  // And only when we actually sent a validator. A 304 to a request that
  // asked nothing conditional -- a broken intermediary -- has no cached
  // body behind it, so treating it as a hit would be inventing content.
  // It falls through to the failure branch instead.
  if (res.status === 304 && validator) {
    // The server re-sends the tag on a 304; falling back to the one we
    // sent keeps the next revalidation conditional if it does not.
    return { ok: true, notModified: true, etag: readEtag(res) ?? validator };
  }

  if (!res.ok) {
    return await failureFrom(res);
  }
  const next = readEtag(res);
  if (res.status === 204) return { ok: true, notModified: false, data: undefined as T, etag: next };
  return { ok: true, notModified: false, data: (await res.json()) as T, etag: next };
}
