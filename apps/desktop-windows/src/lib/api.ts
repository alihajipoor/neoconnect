import { fetch } from "@tauri-apps/plugin-http";
import { apiEndpoints, forgetEndpoint, rememberedEndpoint, rememberEndpoint } from "./api-endpoints";
import { deviceHeaders } from "./device-identity";
import { maybeRefreshBundle } from "./endpoint-bundle-store";
import {
  clearDemotion,
  demotedLast,
  demoteEndpoint,
  isDemoted,
  isNameDemoted,
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
 * Per name, not per address. The TCP handshake's part of it is shared
 * among the addresses the name resolves to: hyper-util, under reqwest,
 * gives each address of one family this divided by how many there are
 * (`ConnectingTcpRemote::new` in hyper-util 0.1.20). A CDN name with two
 * IPv4 addresses gives each five seconds to complete its handshake. That
 * is mostly a gain -- with the first address blackholed the second is
 * tried at five seconds, where otherwise the whole name would fail at ten
 * -- and a cost only on a path that needs more than five seconds of
 * retransmitted handshakes at every address, which is unverified either
 * way.
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

/** The addresses the backend has answered from in this run, as far as
 * an answer can show it (`servesBackend`). See `refusedByBackend` for why
 * a 401 does not count. */
const servedBackend = new Set<string>();

/** The addresses that have answered a public request, in this run, with
 * JSON the backend never gives one: a 401, a 403 or a 404 to the health
 * check or the sign-in challenge (`notePublicAnswer`). Their refusals are
 * not the backend's -- `foreignAnswer` treats them as pages -- until the
 * address serves the backend's JSON again. */
const notBackend = new Set<string>();

/** The JSON statuses an address that is not the backend has been seen
 * answering every request with. The backend gives them too -- an expired
 * token, a forbidden route, a missing one -- so one of them, alone, proves
 * neither that an address is the backend nor that it is not. */
const DOUBTFUL_STATUSES = new Set([401, 403, 404]);

/** Whether `response` is JSON in one of the `DOUBTFUL_STATUSES`. */
function isDoubtful(response: Response): boolean {
  return isBackendAnswer(response) && DOUBTFUL_STATUSES.has(response.status);
}

/** Whether `response` shows that its address reaches the backend: its
 * JSON, in any status but the doubtful ones. */
function servesBackend(response: Response): boolean {
  return isBackendAnswer(response) && !DOUBTFUL_STATUSES.has(response.status);
}

function noteAnswer(base: string, response: Response): void {
  // Whatever answered, the network let a request through to this
  // address, so it is no longer one to ask last (endpoint-demotion.ts).
  clearDemotion(base);
  // Tests stand responses in with plain objects; anything else cannot be
  // keyed, and there is nothing to note about it.
  if (typeof response !== "object" || response === null) return;
  answeredBy.set(response, base);
  // Not a 403 or a 404 either. An address answering JSON 404 to the
  // public health check used to be counted here by that very answer, and
  // its JSON 401 to the token refresh was then believed: the customer was
  // signed out, and the tunnel taken down, by an address the health check
  // had just shown was not the backend.
  if (servesBackend(response)) {
    servedBackend.add(base);
    notBackend.delete(base);
  }
  if (servesBackend(response) || bodilessSuccess(response)) announceBackendAnswer();
}

/** An answer with no body and no type that the rest of this file takes as
 * the backend's own (`isForeignPage`): its 204 to a report or a release,
 * its 304 to a revalidated read. */
function bodilessSuccess(response: Response): boolean {
  return (response.ok || response.status === 304) && !isBackendAnswer(response) && !isForeignPage(response);
}

/** Who is told when the backend answers. See `onBackendAnswer`. */
const answerListeners = new Set<() => void>();

/** Calls `listener` whenever the backend answers any request this app
 * sends, through any address, whatever the request was: its JSON in any
 * status but the doubtful ones (`servesBackend`), or a success with no
 * body. Not a page from in front of it, which says nothing about whether
 * Neoxify was reached. Returns the function that stops it.
 *
 * For a screen that has said Neoxify cannot be reached: the claim before
 * a connect, a report delivered, a renewal answered -- any of them makes
 * that untrue, and the screen has to stop saying it then, not when its
 * own next request happens to go out. On the test VM the dashboard's
 * banner went on saying "Can't reach Neoxify" for a minute after the
 * claim and the queued reports had been answered through the tunnel
 * (offline-retry.ts). */
export function onBackendAnswer(listener: () => void): () => void {
  answerListeners.add(listener);
  return () => {
    answerListeners.delete(listener);
  };
}

function announceBackendAnswer(): void {
  for (const listener of [...answerListeners]) {
    try {
      listener();
    } catch {
      // A screen's handler failing is no reason for this request to.
    }
  }
}

/** Whether this answer to the public health check proves the address
 * reaches the backend: its JSON, saying it is up (200), that its database
 * is not (503), or that the throttle wants a pause (429). Nothing else is
 * an answer the backend gives there. A 401, 403 or 404 in JSON is a
 * broken address that answers everything that way, and has been seen to
 * win the race for it. */
function provesBackend(response: Response): boolean {
  return isBackendAnswer(response) && (response.ok || response.status === 503 || response.status === 429);
}

/** Notes what an answer to a public request -- the health check, the
 * sign-in challenge -- said about `base`: JSON the backend never gives
 * there (`isDoubtful`) shows the address is not the backend.
 *
 * Nothing else does. A page is what is in front of the backend speaking
 * (`isForeignPage`), and says nothing about what is behind it: a CDN's 521
 * or a mirror's 502 during a deploy is an address that reaches the backend
 * whenever the backend is up. Counted here, such a page outlived the deploy
 * that caused it: the address's JSON 401 was a page from then on, an
 * expired access token was never renewed, and every screen said "Request
 * failed (401)" until some write happened to check the address again. */
function notePublicAnswer(base: string, response: Response): void {
  if (!isDoubtful(response)) return;
  notBackend.add(base);
  servedBackend.delete(base);
}

/** Whether `response`, from `base`, is to be treated as a page from in
 * front of the backend rather than the backend's own answer: a page
 * (`isForeignPage`), or a refusal from an address whose health check has
 * shown it is not the backend (`notBackend`). The second answers faster
 * than the backend can. Its JSON 401 won every read it answered first,
 * took the token refresh there and refused it, so every screen said the
 * session could not be renewed while the backend would have renewed it
 * one address along. */
function foreignAnswer(base: string, response: Response): boolean {
  return isForeignPage(response) || (!response.ok && notBackend.has(base));
}

/** `foreignAnswer`, for a response already out of the race or the walk
 * that heard it. */
function foreignResponse(response: Response): boolean {
  const base = answeredBy.get(response);
  return base === undefined ? isForeignPage(response) : foreignAnswer(base, response);
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
  // And it is not offered to the next write as the address that answers
  // (`recentWinner`), whichever request found out.
  forgetWinner(base);
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
  /** Whether its name's DNS answer is looked at beside the request, as a
   * race does for every address (`blockPageLook`): for a write sent
   * straight to an address before any race (`recentStop`). */
  blockPageLook?: boolean;
}

/** How long an address the backend has just answered from is trusted to
 * take a write without asking the endpoints again (`recentWinner`).
 *
 * Long enough to cover what follows a read in the ordinary course of
 * things: the token refresh after a read's 401, a route switch after the
 * route list, a report after the screen that failed. And longer than the
 * device slot's renewal period (sixty seconds, `DEFAULT_RENEW_EVERY_SEC`
 * in device-slots.ts), because each answered write renews the trust: while
 * a tunnel is up and its renewals are answered, the release on Disconnect
 * has an address to go straight to. At exactly sixty seconds, about half
 * of all disconnects found the trust lapsed and spent their second and a
 * half on a health check first; on a link where a fresh connection takes
 * eight hundred milliseconds that is the whole budget, and the slot stayed
 * held until it went stale. Short enough that a network change or a block
 * that has just landed costs a write one timeout at the old address, and
 * then the health race (`sendWrite`). */
const PROVEN_FOR_MS = 90_000;

/** What a write asks the endpoints before it is sent, when no race has
 * found an answering address in the last `PROVEN_FOR_MS`. The backend's
 * health check: unauthenticated, small, stores nothing, and JSON from the
 * backend whatever it says -- a 503 from it saying the database is down
 * still proves the address reaches the backend. */
const HEALTH_PATH = "/health";

/** The last address the backend itself answered from: where, how fast,
 * and when. Any race's winner counts -- a read's, the sign-in
 * challenge's, a write's health race -- and so does a write that was
 * answered.
 *
 * `refusal` marks a read won by a JSON 401. That is the backend's answer
 * to an expired access token, and the token refresh that follows it goes
 * straight there; but an address that is not the backend answers 401 to
 * everything, so no other write is sent on the strength of it
 * (`recentWinner`). */
let lastWinner: (AnsweredBase & { at: number; refusal: boolean }) | null = null;

function noteWinner(base: string, ms: number, refusal = false): void {
  lastWinner = { base, ms, at: Date.now(), refusal };
}

/** Stops offering `base` to the next write: it has just failed a request,
 * or answered one with a page from in front of the backend.
 *
 * Only the write that found the last winner failing used to forget it. A
 * health race's winner that then timed out on the write, a challenge's
 * winner whose sign-in got nothing, a read's winner that answered the
 * next request with a 502 page: each was offered to every write for the
 * rest of the minute, and each of those writes waited out the same
 * timeout there, or stopped on the same page, before asking anywhere
 * else. */
function forgetWinner(base: string): void {
  if (lastWinner?.base === base) lastWinner = null;
}

/** The last winner, if the backend answered there within `PROVEN_FOR_MS`
 * and the address has not been demoted on this network since -- a
 * demoted address never leads a race, and does not lead a write either.
 *
 * Nor an address shown since not to be the backend (`notBackend`), nor,
 * for any write but the token refresh, one whose winning answer was a 401.
 * An address answering JSON 401 to everything won the launch's public
 * read, and the attempt report that followed went there alone, with no
 * health check: its 401 counted the report as delivered, and the report
 * was dropped while the backend answered one address along. */
function recentWinner(forRefresh = false): AnsweredBase | null {
  if (lastWinner === null) return null;
  const age = Date.now() - lastWinner.at;
  // A clock set back is not a fresh answer.
  if (age < 0 || age >= PROVEN_FOR_MS) return null;
  if (isDemoted(lastWinner.base) || notBackend.has(lastWinner.base)) return null;
  if (lastWinner.refusal && !forRefresh) return null;
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
  notBackend.clear();
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

/** Whether a page with this status may have come after the backend acted
 * on the request (`MAY_HAVE_REACHED_BACKEND`). For a sign-up, which must
 * not be sent twice (`mayTryAgain` in auth.ts). */
export function mayHaveReachedBackend(status: number | undefined): boolean {
  return status !== undefined && MAY_HAVE_REACHED_BACKEND.has(status);
}

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
 * A success is a page too when it says it carries something other than
 * JSON: a node's fallback site answers 200 with its HTML to any path.
 * That one used to win a read in ten milliseconds, be remembered and asked
 * for the bundle, and then fail the read on its body. A success with no
 * type at all is not counted: the backend's 204s and 304s carry no body
 * and no type. */
export function isForeignPage(response: Response): boolean {
  if (isBackendAnswer(response)) return false;
  if (response.status >= 400) return true;
  return (response.headers?.get?.("content-type") ?? "") !== "";
}

/** Thrown for a write whose health race the backend answered, when the
 * write itself then got no answer anywhere it was sent. Neoxify was
 * reached moments earlier, so this is not "could not reach Neoxify". */
class StoppedAnswering extends Error {}

/** Thrown when nothing answered because every address asked had a name
 * that resolves to Iran's DNS block page and nothing else
 * (`resolvesToBlockPage`). The customer's connection works; this network
 * sends Neoxify's names to the block page, and the screen says that
 * rather than telling them to check their connection (`BLOCKED_BY_NETWORK`). */
class OnBlockPage extends Error {}

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
  /** Whether the walk ends at the first address that took the request and
   * then did not answer in time: a sign-in's, whose single-use solution
   * that address may already have spent (`fetchAnyEndpoint`). */
  endOnTimeout?: boolean;
  /** Whether the walk keeps to the addresses it was given, in the order it
   * was given them: a sign-in's, which goes only where its challenge race
   * was answered (`via` in `fetchAnyEndpoint`). The remembered endpoint is
   * then not followed (`followRemembered`). */
  listedOnly?: boolean;
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
 * seconds in all, before reaching it.
 *
 * Not for a walk that keeps to its list (`listedOnly`): a sign-in, sent
 * only to the addresses whose answers to its own challenge race proved
 * they reach the backend, winner first. An address another request had
 * remembered meanwhile was put at the head of that walk, and the attempt,
 * with its single-use solution, went to an address this sign-in had
 * never heard from -- and ahead of the one that handed out the challenge,
 * when it was in the list but further down. */
async function followRemembered(queue: Stop[], walk: Walk): Promise<void> {
  if (walk.listedOnly) return;
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
    // Whether the name's DNS answer, looked at beside the request, was the
    // block page (`blockPageLook`), and whether the request has settled.
    let onBlockPage = false;
    let over = false;
    try {
      if (stop.blockPageLook) {
        const look = blockPageLook(base);
        if (await look.beforeSending) {
          onBlockPage = true;
          throw new Error("on the block page");
        }
        void look.found.then((found) => {
          if (!found || over) return;
          onBlockPage = true;
          controller.abort();
        });
      }
      const response = await send(base, path, init, controller.signal);
      settleAttempt(entry, `h${response.status}`);
      if (foreignAnswer(base, response)) {
        // Never remembered and never asked for the bundle: it is not the
        // service. The CDN's 502 page used to be both, and then led every
        // write after it. Nor is it offered to the next write any more,
        // if it had won a race. A gateway page that may have come after
        // the backend acted still ends a write that must not be sent
        // twice; any other page is kept, and the next address is tried.
        forgetWinner(base);
        if (MAY_HAVE_REACHED_BACKEND.has(response.status) && !REPEATABLE_WRITES.has(path)) return response;
        walk.page ??= response;
        continue;
      }
      void rememberEndpoint(base);
      // The backend answered here, so the next write may come straight
      // here too (`recentWinner`), and the address bundle may be asked
      // for here. Not on a JSON 401, 403 or 404, which an address that is
      // not the backend gives as well (`isDoubtful`): one such answer
      // renewed that address's trust for the next write, and spent the
      // run's only bundle refresh on an address that could not serve it.
      if (!isDoubtful(response)) {
        void maybeRefreshBundle(base);
        noteWinner(base, Date.now() - startedAt);
      }
      return response;
    } catch (err) {
      // Stopped by the caller's deadline rather than failing: left
      // pending, which the trace renders as `budget`. Recording it as a
      // transport failure would say the network refused an address that
      // was simply still being waited for.
      if (timedOut || !outer?.aborted) {
        settleFailure(entry, base, onBlockPage ? "blockpage" : failedAs(err, timedOut, startedAt));
      }
      walk.lastError = err;
      if (timedOut && walk.endOnTimeout) break;
    } finally {
      over = true;
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

/** Where a write goes before anything is asked, if anywhere: the address
 * the backend last answered from (`recentWinner`) -- or, for a write with
 * a deadline of its own, the remembered endpoint when no race has been won
 * lately.
 *
 * Those writes are the device slot's: the claim before a dial has three
 * seconds, the release on Disconnect a second and a half. A health check
 * and then the write is two fresh connections in a row, because the HTTP
 * plugin builds a new client for every request; on a link where one takes
 * a second and a half the claim spent its three seconds and was never
 * sent, where going straight to the remembered address, as every write did
 * before the health race, was granted in half that. A deadline that short
 * leaves the health race no time after a dead address either, so the
 * address that answered last is the better bet -- even one demoted on this
 * network since, which is how a timeout through a failing tunnel left the
 * release on Disconnect a health race whose first stage alone outlasted
 * it. Not an address shown not to be the backend (`notBackend`). Either
 * way the address's name is looked at beside the request
 * (`blockPageLook`), so one this network sends to the block page holds up
 * nothing. */
function recentStop(path: string, outer: AbortSignal | null, walk: Walk): Stop | null {
  const recent = recentWinner(path === REFRESH_PATH);
  if (recent !== null) return { base: recent.base, timeoutMs: followUpTimeout(recent), blockPageLook: true };
  const remembered = walk.remembered;
  if (outer === null || remembered === undefined || notBackend.has(remembered)) return null;
  return { base: remembered, timeoutMs: timeoutAt(remembered), blockPageLook: true };
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
 * First, the address the backend last answered from, if that was within
 * `PROVEN_FOR_MS` (`recentWinner`) -- the usual case, since writes mostly
 * follow reads or other writes -- or, for a write with a short deadline of
 * its own, the remembered endpoint (`recentStop`). Otherwise, or if that
 * address does not answer, the endpoints not yet tried are raced for the
 * health check (`raceForHealth`), and the write walks only those whose
 * answer proved they reach the backend, in the order they answered, each
 * given time to answer at the pace it just showed. Throughout, the
 * remembered endpoint is read again before each step (`followRemembered`).
 *
 * If none of those takes the write, the race is run again over the
 * addresses it has not yet heard from -- the ones stopped when the first
 * answer came in -- and so on until one takes it or nothing more answers.
 * An address that failed a health race, answered it with a page, or has
 * been sent the write, is not asked again, so every round is smaller than
 * the one before. Usually there is one round: the address that answered
 * the health check takes the write.
 *
 * An address that answered the health check with a page from in front of
 * the backend is never sent the write. Its page showed it cannot reach
 * the backend just now -- a mirror whose upstream is broken answers 502 --
 * and when it went ahead of the addresses not yet asked, its 502 ended a
 * write that must not be sent twice (`MAY_HAVE_REACHED_BACKEND`) before
 * an address that would have taken it was ever asked. Its page is still
 * the answer if nothing better comes: something did reply, so the write
 * says what, rather than "could not reach Neoxify".
 *
 * The write itself is still sent to one address at a time, and to each
 * at most once, for the reasons `fetchAnyEndpoint` gives. When nothing
 * answers the health race the write is not sent at all, and the result is
 * "could not reach Neoxify" -- after `2 * LEAD_MS + SLOW_ANSWER_MS`,
 * twenty-three seconds, at most; eleven and a half where no address
 * completes a connection (`CONNECT_TIMEOUT_MS`); and up to
 * `SLOW_ANSWER_MS` more when a recent winner was asked first and did not
 * answer -- rather than after a walk of the whole list. When the backend
 * answered this write's health race, and then the write got no answer,
 * `StoppedAnswering` is thrown instead: Neoxify was reached moments
 * earlier. Not when only an earlier answer, to another request, sent the
 * write where it got nothing: nothing answered this write. */
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
  // Whether the backend itself answered one of this write's health races.
  let reached = false;
  // The first page a health race heard, the answer of last resort.
  let healthPage: Response | null = null;
  // Addresses whose answer to the health check was a page.
  const paged = new Set<string>();
  // Whether every health race so far ended with every address on the
  // block page, and nothing else.
  let onBlockPage = false;

  // Not `reached` when it fails. Its answer was to another request, up to
  // a minute and a half ago and perhaps on another network; a write that
  // then got nothing there or anywhere else was answered by nothing, and
  // said that Neoxify had stopped responding where the next write, on the
  // same network a moment later, said it could not be reached.
  const first = recentStop(path, outer, walk);
  if (first !== null) {
    const response = await fetchOneEndpointAtATime(path, init, [first], walk, trace);
    if (response) return response;
  }

  let stops: Stop[] = [];
  for (;;) {
    if (stops.length > 0) {
      const response = await fetchOneEndpointAtATime(path, init, stops, walk, trace);
      if (response) return response;
    }
    candidates = candidates.filter((base) => !walk.tried.has(base) && !paged.has(base));
    if (candidates.length === 0 || outer?.aborted) break;
    const health = await raceForHealth(candidates, outer, trace);
    reached ||= health.backend;
    healthPage ??= health.page;
    onBlockPage = health.blockPage && !reached && healthPage === null;
    for (const base of health.pages) paged.add(base);
    if (health.answered.length === 0) break;
    candidates = candidates.filter((base) => !health.silent.includes(base));
    stops = health.answered.map((answered) => ({ base: answered.base, timeoutMs: followUpTimeout(answered) }));
  }
  // A write cut off by its caller's own deadline was not left unanswered
  // by the backend: that is the caller's to say, as before.
  if (outer?.aborted) return unanswered(walk, init);
  if (walk.page) return walk.page;
  if (reached) throw new StoppedAnswering();
  if (healthPage) return healthPage;
  if (onBlockPage) throw new OnBlockPage();
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
 *
 * Every address in `via` gets `SLOW_ANSWER_MS`, whatever pace it answered
 * the race at: an address that has just answered in a hundred
 * milliseconds can still be a slow route the next time. Only the last one
 * used to, so a sign-in whose challenge race had also heard a throttled
 * mirror cut the address that handed out the challenge off at eight
 * seconds, when its answer took twelve. And the walk ends at the first
 * address that took the request and did not answer in that time. The
 * sign-in carries a single-use solution, which that address may already
 * have spent: sent on with it, the sign-in was refused by the throttled
 * mirror as a security check already used, for a sign-in that had gone
 * through. A sign-in may be tried again with a fresh challenge
 * (`sendWithChallenge` in auth.ts); a transport failure that came sooner
 * still goes on to the next address, as it always has. The caller's own
 * deadline bounds all of it.
 *
 * Nothing but those addresses is sent the request (`listedOnly`): not even
 * the remembered endpoint, which every other walk follows when another
 * request finds it answering meanwhile (`followRemembered`).
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
    const stops = via.map((answered) => ({ base: answered.base, timeoutMs: SLOW_ANSWER_MS }));
    const walk: Walk = { ...(await newWalk()), endOnTimeout: true, listedOnly: true };
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
  // (`foreignAnswer`): the backend's JSON, whatever its status, and the
  // bodiless 204s and 304s it sends with no type at all.
  const { winner, answers, stop, blockPage } = await staggeredRace(
    endpoints,
    path,
    init,
    (answer) => !foreignAnswer(answer.base, answer.response),
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
  if (init.signal?.aborted) throw new Error("the request ran out of time");
  // Every address was on the block page: not the customer's connection.
  if (blockPage) throw new OnBlockPage();
  // Thrown so the callers keep their "could not reach Neoxify" handling;
  // which address failed how is the trace's to say.
  throw new Error("no API endpoint answered");
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
  /** Set beside `noResponse` when nothing answered because every address
   * asked had a name that resolves to Iran's DNS block page and nothing
   * else (`resolvesToBlockPage` in endpoint-demotion.ts). The connection
   * works; the network is keeping Neoxify's names from it, and the screen
   * says so rather than sending the customer to check a connection that
   * is fine (failure-text.ts). */
  blockPage?: true;
  /** Set when what answered was not the backend: a page from in front of
   * it (`isForeignPage`), or an answer from an address shown not to be the
   * backend (`foreignAnswer`). Something replied, so this is not
   * `noResponse`; but the backend was not reached through it, which is
   * what decides whether a sign-in may be tried again elsewhere
   * (`sendWithChallenge` in auth.ts) and whether a failed screen load is
   * reported as one that never reached Neoxify (unanswered-report.ts). */
  page?: true;
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
 * is about to read.
 *
 * English whatever language the app is in, as are `STOPPED_ANSWERING`
 * and `requestFailed`. The sentence is what the attempt reports carry to
 * the panel, inside diagnostics written in English, and the panel is read
 * in English. What a customer is shown is chosen by `noResponse` and the
 * status in failure-text.ts, in their own language. */
export const unreachable = (): RequestFailure => ({
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

/** What a request says when nothing answered and every address it asked
 * had a name resolving to Iran's DNS block page (`OnBlockPage`). It
 * begins as `unreachable` does, so a report read by its sentence is still
 * an unreachable control plane; what the customer is shown is chosen by
 * `blockPage` (failure-text.ts). */
export const BLOCKED_BY_NETWORK = "Could not reach Neoxify: this network's DNS sends its addresses to a block page.";

/** What a request says when the backend answered it with a 401 and the
 * token refresh that followed then got no answer at all. Neoxify was
 * reached moments earlier, so this is not "could not reach Neoxify"; and
 * the session is not over, so it is not a sign-out either. */
export const RENEWAL_UNANSWERED = "Neoxify answered, but renewing your session got no answer. Please try again.";

/** What a request says when its token refresh was answered, but not with
 * new tokens and not with a refusal of the session: a page from in front of
 * the backend, the throttle, a server error, or a 401 from an address that
 * is not the backend. */
export const RENEWAL_FAILED = "Could not renew your session just now. Try again in a moment.";

/** The failure for a request that got no answer: see `StoppedAnswering`
 * and `OnBlockPage`. */
function unansweredFailure(err: unknown): RequestFailure {
  if (err instanceof StoppedAnswering) return { ok: false, error: STOPPED_ANSWERING, noResponse: true };
  if (err instanceof OnBlockPage) return { ok: false, error: BLOCKED_BY_NETWORK, noResponse: true, blockPage: true };
  return unreachable();
}

/** Thrown in place of a body that was still being read when the caller's
 * own deadline ran out (`readWithin`). */
class BodyStalled extends Error {}

/** `read`, a response body being read, given up on when `signal` fires.
 *
 * A race hands back the winner's response as soon as its headers arrive,
 * and lets go of the caller's signal then, so that a caller's deadline
 * firing later cannot cancel the body (`staggeredRace`). That left the
 * body itself with no limit at all: a challenge whose headers came back
 * and whose body never finished kept "Signing in..." on screen for good,
 * deadline or not. This bounds the wait, not the request -- the body is
 * not cancelled, only no longer waited for. Without a signal, as before. */
function readWithin<T>(read: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return read;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new BodyStalled());
    if (signal.aborted) {
      // Settled either way, so nothing is left rejecting unobserved.
      read.catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    read.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** The failure for an answer whose body could not be had: one the
 * caller's deadline overtook (`BodyStalled`) -- headers from the backend,
 * then nothing, which is the backend having stopped responding -- or one
 * that was not the JSON it said it was. */
function bodyFailure(err: unknown, res: Response): RequestFailure {
  if (err instanceof BodyStalled && isBackendAnswer(res)) return { ok: false, error: STOPPED_ANSWERING, noResponse: true };
  return { ok: false, error: requestFailed(res.status), status: res.status };
}

/** The sentence for an answer that carried no message of its own: a page
 * from in front of the backend, or a body that was not the JSON promised.
 *
 * One function for both places that word it, and exported, because the
 * screens tell this case apart from the backend's own refusals by it
 * (failure-text.ts): something answered, with an error and nothing to say
 * about it, which is neither "could not reach Neoxify" nor a sentence the
 * backend wrote for the customer. */
export function requestFailed(status: number): string {
  return `Request failed (${status})`;
}

/** A refusal, in full: the sentence, the status, and the code.
 *
 * The body is read once and every part of the answer is kept. Reading it
 * only for its message is what made a 409 indistinguishable from any
 * other failure to every caller. */
async function failureFrom(res: Response, signal?: AbortSignal | null, foreign = false): Promise<RequestFailure> {
  // Not the backend's answer (`foreignResponse`): whatever its body says,
  // it is not a sentence the backend wrote, nor one of its codes.
  if (foreign) return { ok: false, error: requestFailed(res.status), status: res.status, page: true };
  const body: unknown = await readWithin(res.json(), signal).catch(() => null);
  const fields = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const message = fields?.message;
  const error = Array.isArray(message)
    ? message.join(", ")
    : typeof message === "string"
      ? message
      : requestFailed(res.status);
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

  // A page is never a success, whatever its status: a node's fallback
  // site answers 200 with HTML.
  const foreign = foreignResponse(res);
  if (!res.ok || foreign) {
    return await failureFrom(res, init?.signal, foreign);
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  try {
    return { ok: true, data: (await readWithin(res.json(), init?.signal)) as T };
  } catch (err) {
    return bodyFailure(err, res);
  }
}

/** What a race found: the answer, and who else answered. */
export interface Raced<T> {
  result: ApiResult<T>;
  /** Every address the backend itself answered from (`isBackendAnswer`),
   * in the order a follow-up should try them: the one whose answer became
   * `result` first, then the backend's other answers -- a mirror over its
   * throttle. Empty when the backend answered nowhere. */
  answered: AnsweredBase[];
  /** The addresses that answered only with a page from in front of the
   * backend. Something replied there, so `result` is that page's status
   * when nothing better came; but the backend was not reached through
   * them, and a follow-up is not sent there. */
  pages: string[];
  /** The addresses that gave no answer at all. Not those stopped because
   * another answered, nor those the race was decided without asking. */
  failed: string[];
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
  /** Whether nothing answered because every address had a name resolving
   * to Iran's block page and nothing else (`OnBlockPage`). */
  blockPage: boolean;
  /** Stops every request still running, except `spare`'s, whose body the
   * caller is about to read. */
  stop(spare?: RaceAnswer): void;
}

/** Thrown in place of a request a race decided without: its address was
 * still having its name looked at when an answer came in (`blockPageLook`). */
class NotSent extends Error {}

/** A look at `base`'s name, for a request about to go there
 * (`resolvesToBlockPage` in endpoint-demotion.ts).
 *
 * `found` is whether the name resolves to Iran's block page and nothing
 * else; a request already sent is stopped when it says so.
 * `beforeSending` is what to wait for before sending at all: the look
 * itself, for a name this network has sent to the block page in the last
 * half hour (`isNameDemoted`), and nothing for any other name, which is
 * asked at once.
 *
 * Such a name used to be sent a request anyway. The look starts beside the
 * request, and the request was queued before any look could land, so every
 * race asked every name the race before had just found on the block page:
 * a TCP handshake and a TLS hello naming a blocked host, to the block page,
 * before the look caught up and stopped it. Waiting for the look is a call
 * into the app, answered from the resolver's cache, and never longer than
 * `RESOLVE_TIMEOUT_MS`. It is looked at again rather than trusted, because
 * the path may have changed since: through a tunnel just up, the name
 * resolves for real. */
function blockPageLook(base: string): { found: Promise<boolean>; beforeSending: Promise<boolean> } {
  const found = resolvesToBlockPage(base);
  return { found, beforeSending: isNameDemoted(base) ? found : Promise.resolve(false) };
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

/** When a race may end without a winner before every address has
 * settled: told the addresses still to settle, asked or not, and the
 * answers so far. For a caller that knows what it will do with the
 * outcome by then (`answeringEndpoint`). */
type GiveUp = (pending: string[], answers: RaceAnswer[]) => boolean;

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
 * without a winner when every address has settled, when the caller's
 * signal fires, or when `giveUp` says the rest cannot change the outcome.
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
 * failed, so the next stage need not wait out the head start on it; the
 * name is demoted on this network. A name already demoted that way is
 * looked at before anything is sent to it, and not sent anything if it is
 * still on the block page (`blockPageLook`). When every address ends that
 * way, the race says so (`blockPage`): it is the network, not the
 * connection.
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
  giveUp?: GiveUp,
): Promise<Staggered> {
  const { ordered, healthy } = demotedLast(endpoints);
  // With nothing to ask there is no stage to settle the race; every
  // caller checks first, and this keeps one that did not from waiting for
  // ever.
  if (ordered.length === 0) return { winner: null, answers: [], failed: [], blockPage: false, stop: () => undefined };
  const stages = stagesOf(ordered.length, healthy);
  const outer = request.signal ?? null;
  const controllers = ordered.map(() => new AbortController());
  // Which aborts were our own deadline, so the trace can say "timeout"
  // rather than the generic transport failure the abort surfaces as.
  const timedOut = ordered.map(() => false);
  // Which were stopped, or never sent, because the name resolves to the
  // block page, and how many of the failures that makes.
  const blockPage = ordered.map(() => false);
  let failedOnBlockPage = 0;
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
    // stops it -- or keeps it from being sent at all, for a name this
    // network has sent there lately (`blockPageLook`).
    const look = blockPageLook(base);
    void look.found.then((found) => {
      if (!found || done[i] || decided) return;
      blockPage[i] = true;
      controllers[i].abort();
    });
    // Started inside a promise, so a fetch that throws rather than
    // rejecting is still one address failing, not the whole race.
    void Promise.resolve()
      .then(async () => {
        if (await look.beforeSending) blockPage[i] = true;
        if (blockPage[i]) throw new Error("on the block page");
        // Decided while its name was looked at -- an answer came in, or the
        // caller's deadline ran out -- so it is not sent, and the trace is
        // left for `stop` to mark, as for an address asked and stopped.
        if (decided) throw new NotSent();
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
          // A page from the address the last write went straight to: it is
          // not offered to the next one (`forgetWinner`).
          if (foreignAnswer(base, response)) forgetWinner(base);
          if (wins(answer)) decide(answer);
        },
        async (err: unknown) => {
          if (err instanceof NotSent) {
            done[i] = true;
            return;
          }
          // A failure that came back before the name's look did -- a
          // connection to the block page reset in milliseconds -- waits for
          // the look, which is bounded (`RESOLVE_TIMEOUT_MS`). Settled
          // without it, it was recorded as a plain transport failure, and a
          // network sending every name to the block page was told, or not,
          // depending on which of the two came back first.
          if (!blockPage[i] && !decided && !timedOut[i] && (await look.found)) blockPage[i] = true;
          done[i] = true;
          const outcome = blockPage[i] ? "blockpage" : failedAs(err, timedOut[i], startedAt);
          if (!decided) {
            failed.push(base);
            if (outcome === "blockpage") failedOnBlockPage += 1;
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
        else if (giveUp?.(ordered.filter((_, j) => !done[j]), answers)) decide(null);
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
    // client -- but not on a JSON 401, 403 or 404 (`isDoubtful`), which
    // spent the run's one refresh on an address that may not be the
    // backend at all. A JSON 401 is offered to the token refresh it
    // causes and to no other write (`recentWinner`).
    void rememberEndpoint(winner.base);
    if (!isDoubtful(winner.response)) {
      if (winner.backend) noteWinner(winner.base, winner.ms);
      void maybeRefreshBundle(winner.base);
    } else if (winner.response.status === 401) {
      noteWinner(winner.base, winner.ms, true);
    }
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
  // Every address asked, every one failed, and every failure the block
  // page: the network's DNS, not the connection.
  const onBlockPage = winner === null && answers.length === 0 && failedOnBlockPage === ordered.length;
  return { winner, answers, failed, blockPage: onBlockPage, stop };
}

/** The addresses in `answers`, in the order a follow-up should try them:
 * `winner` first, if it is among them, then the rest in the order they
 * answered. Each once. */
function inAnswerOrder(winner: RaceAnswer | null, answers: RaceAnswer[]): AnsweredBase[] {
  const ordered = [...(winner && answers.includes(winner) ? [winner] : []), ...answers.filter((a) => a !== winner)];
  const answered: AnsweredBase[] = [];
  for (const answer of ordered) {
    if (!answered.some((a) => a.base === answer.base)) answered.push({ base: answer.base, ms: answer.ms });
  }
  return answered;
}

/** Each address once, in the order given. */
function distinctBases(answers: RaceAnswer[]): string[] {
  return [...new Set(answers.map((answer) => answer.base))];
}

/** Sends one unauthenticated request to the endpoints as a staggered
 * race (`staggeredRace`), and reports who answered as well as what the
 * answer was.
 *
 * Only for a request that the server does not mind receiving more than
 * once -- nothing stored, nothing spent, beyond the throttle's count --
 * whose every answer is JSON, and which is public: the backend never
 * answers it 401, 403 or 404, so an address that does is not the backend
 * (`notePublicAnswer`). The sign-in challenge is the reason
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
 * `endpoints`, when given, replaces the list: a sign-in whose attempt got
 * no answer where the first race was answered asks the rest of the list
 * for a fresh challenge (`sendWithChallenge` in auth.ts).
 *
 * The rest are stopped as soon as the winner is in. The winner's body is
 * read within the caller's signal (`readWithin`), which the race itself
 * has let go of by then.
 */
export async function publicRace<T>(
  path: string,
  init: RequestInit,
  trace?: EndpointTrace,
  endpoints?: string[],
): Promise<Raced<T>> {
  const list = endpoints ?? (await apiEndpoints());
  if (list.length === 0 || init.signal?.aborted) return { result: unreachable(), answered: [], pages: [], failed: [] };
  const request: RequestInit = {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  };

  // The backend's own answer: its JSON, and neither a JSON 401, 403 or 404
  // (`isDoubtful`), which it never gives a public request like this one,
  // nor anything from an address already shown not to be the backend
  // (`foreignAnswer`). An address answering JSON 401 to everything used to
  // win this race inside its head start, be remembered, and be sent the
  // sign-in alone; the customer was told "Unauthorized", which reads like
  // a wrong password, and every retry did the same while the backend
  // would have answered one address along. Such an answer is a page here.
  const fromBackend = (answer: RaceAnswer) =>
    answer.backend && !isDoubtful(answer.response) && !foreignAnswer(answer.base, answer.response);
  const { winner, answers, failed, blockPage, stop } = await staggeredRace(
    list,
    path,
    request,
    (answer) => {
      notePublicAnswer(answer.base, answer.response);
      return fromBackend(answer) && answer.response.status !== 429;
    },
    trace,
  );

  // The answer that becomes the result: the winner, or failing that the
  // first 429, or failing that the first page.
  const kept = winner ?? answers.find(fromBackend) ?? answers[0];
  stop(kept);
  if (kept === undefined) {
    const result = blockPage ? unansweredFailure(new OnBlockPage()) : unreachable();
    return { result, answered: [], pages: [], failed };
  }
  return {
    result: await resultFrom<T>(kept.response, fromBackend(kept), init.signal),
    answered: inAnswerOrder(winner, answers.filter(fromBackend)),
    pages: distinctBases(answers.filter((answer) => !fromBackend(answer))),
    failed,
  };
}

/** What a health race found (`raceForHealth`). */
interface HealthRace {
  /** The addresses whose answer proved they reach the backend
   * (`provesBackend`), the winner first. */
  answered: AnsweredBase[];
  /** Whether the backend itself answered anywhere. */
  backend: boolean;
  /** The addresses that answered with anything else: a page, or JSON the
   * backend never sends to its health check. */
  pages: string[];
  /** The first of those answers, kept as the answer of last resort. */
  page: Response | null;
  /** The addresses that gave no answer at all, which a later round need
   * not ask again. */
  silent: string[];
  /** Whether every address was on the block page (`OnBlockPage`). */
  blockPage: boolean;
}

/** Races the health check across `endpoints`, for a write about to be
 * sent (`sendWrite`).
 *
 * Won by the first answer that proves the address reaches the backend
 * (`provesBackend`): its JSON saying it is up, that its database is not,
 * or that it is throttled. Nothing is wanted from the answer but the fact
 * of it, and a 429 or a 503 from the backend proves the address reaches
 * it as well as a 200 does. Anything else does not win: a page from in
 * front of the backend, and JSON the backend never gives its public
 * health check, a 401 above all. An address that answers JSON 401 to
 * everything used to win this race, be remembered and asked for the
 * bundle, and take the write -- a report it then counted as delivered, a
 * route switch it refused -- while the backend answered a moment later
 * elsewhere. Such an answer is kept as the answer of last resort, and its
 * address is not sent the write (`sendWrite`).
 *
 * Traced under its own phase, `health`, and the caller's phase put back
 * after. Every request is stopped once the race is decided; no body is
 * read. */
async function raceForHealth(
  endpoints: string[],
  signal: AbortSignal | null,
  trace?: EndpointTrace,
  choosy?: { wins: (response: Response) => boolean; giveUp?: GiveUp },
): Promise<HealthRace> {
  const phase = trace?.phase;
  if (trace) trace.phase = "health";
  try {
    const { winner, answers, failed, blockPage, stop } = await staggeredRace(
      endpoints,
      HEALTH_PATH,
      { method: "GET", signal },
      (answer) => provesBackend(answer.response) && (choosy?.wins(answer.response) ?? true),
      trace,
      choosy?.giveUp,
    );
    stop();
    for (const answer of answers) notePublicAnswer(answer.base, answer.response);
    const others = answers.filter((answer) => !provesBackend(answer.response));
    return {
      answered: inAnswerOrder(
        winner,
        answers.filter((answer) => provesBackend(answer.response)),
      ),
      backend: winner !== null,
      pages: distinctBases(others),
      page: others[0]?.response ?? null,
      silent: failed,
      blockPage,
    };
  } finally {
    if (trace && phase !== undefined) trace.phase = phase;
  }
}

/** The first of `endpoints` whose answer to the health check says it
 * reaches a backend that is up, asked in that order as a staggered race
 * (`raceForHealth`); failing that, the first whose answer proves it reaches
 * the backend at all; or null when none does.
 *
 * For a request that is not this app's to send: the browser's, which
 * starts Google and Facebook sign-in (`socialStartBase` in
 * social-auth.ts). It gets one address and no second try, so it is given
 * one that has just answered, rather than whatever answered last in some
 * earlier run on some other network.
 *
 * And one that answered 200, where any did. For a write a 429 is as good
 * an answer as a 200 -- the address reaches the backend, and the write
 * waits its turn -- but the browser cannot wait its turn. A node's mirror
 * over its throttle won this race, and the browser was sent to start the
 * flow there, behind a stricter throttle of its own, to be shown a raw
 * JSON 429, while another mirror answering 200 a moment later would have
 * started it. A 429 or a 503 is kept for when nothing better answers.
 *
 * `fallback` is where the caller goes when this finds nothing. Once it is
 * the only address left to settle, and nothing has answered, nothing the
 * race can still learn changes where the browser goes, and it ends there:
 * the browser used to wait out the rest of the caller's budget on a slow
 * CDN, with every mirror already refused, and then open at that same CDN. */
export async function answeringEndpoint(
  endpoints: string[],
  signal?: AbortSignal,
  trace?: EndpointTrace,
  fallback?: string,
): Promise<string | null> {
  if (endpoints.length === 0) return null;
  const health = await raceForHealth(endpoints, signal ?? null, trace, {
    wins: (response) => response.ok,
    giveUp: (pending, answers) =>
      fallback !== undefined &&
      pending.every((base) => base === fallback) &&
      !answers.some((answer) => provesBackend(answer.response)),
  });
  return health.answered[0]?.base ?? null;
}

/** The result a raced answer stands for. A page from in front of the
 * backend is never a success, whatever its status: a node's fallback site
 * can answer 200 with HTML to any path. The body is read within `signal`,
 * when the caller brought one (`readWithin`). */
async function resultFrom<T>(res: Response, backend: boolean, signal?: AbortSignal | null): Promise<ApiResult<T>> {
  if (!res.ok || !backend) return await failureFrom(res, signal, !backend);
  if (res.status === 204) return { ok: true, data: undefined as T };
  try {
    return { ok: true, data: (await readWithin(res.json(), signal)) as T };
  } catch (err) {
    return bodyFailure(err, res);
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
 * An address whose 401 is not believed is not the end of the refresh
 * either. Its health check has just shown it is not the backend
 * (`notBackend`), so the refresh is sent on to the other addresses
 * (`refreshTokens`), and from then on its refusals are treated as pages
 * (`foreignAnswer`): they no longer win a read or end a walk. It used to
 * win every read it answered first, and every one of them ended with
 * "could not renew your session" while the backend would have renewed it
 * one address along. */
async function refusedByBackend(res: Response, trace?: EndpointTrace): Promise<boolean> {
  if (res.status !== REFRESH_REFUSED || !isBackendAnswer(res)) return false;
  const base = answeredBy.get(res);
  if (base === undefined) return false;
  if (servedBackend.has(base)) return true;
  await askForHealth(base, trace);
  return servedBackend.has(base);
}

/** Sends the health check to one address and waits for the headers. The
 * answer is noted by `send` like any other, and for what it says about
 * the address (`notePublicAnswer`); nothing else is done with it. Traced under
 * `health`, with the caller's phase put back after. */
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
    notePublicAnswer(base, response);
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
  /** The refresh could not be completed; the session may well be fine.
   * `answered` says whether anything answered the refresh at all, which
   * is the difference between `RENEWAL_FAILED` and `RENEWAL_UNANSWERED`. */
  | { kind: "unavailable"; answered: boolean };

const REFRESH_PATH = "/customer-auth/refresh";

/** `forgetEndpoint`, which is advisory: a request goes on without it. */
function forgetRemembered(base: string): void {
  try {
    void forgetEndpoint(base).catch(() => undefined);
  } catch {
    // Not knowing how to forget costs the next race a head start.
  }
}

async function refreshTokens(trace?: EndpointTrace): Promise<Refresh> {
  const current = await getTokens();
  if (!current) return { kind: "none" };

  const init: RequestInit = {
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
  };
  // Sent through `fetchAnyEndpoint` rather than `publicRequest`, so the
  // response is still in hand to say where a refusal came from.
  let res: Response;
  try {
    res = await fetchAnyEndpoint(REFRESH_PATH, init, trace);
  } catch {
    return { kind: "unavailable", answered: false };
  }
  // Addresses whose refusal turned out not to be the backend's. Each round
  // leaves one more out, so this ends.
  const excluded = new Set<string>();
  for (;;) {
    if (await refusedByBackend(res, trace)) return { kind: "refused" };
    // JSON that `refusedByBackend` has just shown is not the backend's:
    // the refresh goes on to the other addresses, which the one that
    // refused it may have been answering ahead of. It may be sent twice
    // (`REPEATABLE_WRITES`), and this address never acted on it anyway.
    const base = answeredBy.get(res);
    if (base === undefined || !isBackendAnswer(res) || !foreignAnswer(base, res)) break;
    excluded.add(base);
    forgetWinner(base);
    forgetRemembered(base);
    const rest = (await apiEndpoints()).filter((other) => !excluded.has(other));
    if (rest.length === 0) break;
    try {
      res = await sendWrite(REFRESH_PATH, init, rest, trace);
    } catch {
      return { kind: "unavailable", answered: true };
    }
  }

  // A page from in front of the backend is never a new pair of tokens,
  // whatever its status, and nor is anything from an address that is not
  // the backend.
  const result = await resultFrom<TokenPair>(res, isBackendAnswer(res) && !foreignResponse(res));
  if (!result.ok) return { kind: "unavailable", answered: true };
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

  // The backend's 401 only. A 401 page from something in front of it, or
  // from an address that has shown it is not the backend, is the answer of
  // last resort -- nothing better replied -- and says nothing about this
  // session's tokens; it is returned as it is.
  if (res.status === 401 && isBackendAnswer(res) && !foreignResponse(res)) {
    if (trace) trace.phase = "refresh";
    const refreshed = await refreshTokens(trace);
    if (refreshed.kind === "unavailable") {
      // Not a verdict on the session, so neither the tokens nor the
      // screen change. The next request tries the refresh again. In
      // words of its own, which the screens put in the customer's
      // language (failure-text.ts): whether the refresh got no answer
      // at all, or an answer that was not new tokens.
      return {
        answered: false,
        failure: { ok: false, error: refreshed.answered ? RENEWAL_FAILED : RENEWAL_UNANSWERED },
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
    } catch {
      // The backend answered this request and renewed its session moments
      // ago, so a retry that gets nothing is it having stopped responding:
      // not "could not reach Neoxify", which sends the customer to check
      // a connection that has just been shown to work.
      return { answered: false, failure: { ok: false, error: STOPPED_ANSWERING, noResponse: true } };
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

  const foreign = foreignResponse(res);
  if (!res.ok || foreign) {
    return await failureFrom(res, null, foreign);
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  // A body that is not the JSON it said it was is a failure with its
  // status, not a rejection: every caller narrows on `ok`, and none of
  // them catches.
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return bodyFailure(err, res);
  }
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

  const foreign = foreignResponse(res);
  if (!res.ok || foreign) {
    return await failureFrom(res, null, foreign);
  }
  const next = readEtag(res);
  if (res.status === 204) return { ok: true, notModified: false, data: undefined as T, etag: next };
  try {
    return { ok: true, notModified: false, data: (await res.json()) as T, etag: next };
  } catch (err) {
    return bodyFailure(err, res);
  }
}
