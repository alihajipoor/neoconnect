import {
  apiRequest,
  everyRouteFailed,
  LEAD_MS,
  mayHaveReachedBackend,
  publicRequest,
  refusedForRegion,
  relayOnly,
  SLOW_ANSWER_MS,
  STOPPED_ANSWERING,
  unreachable,
} from "./api";
import { relayInstallHeaders, relaySignupOffered, skipNormalRoutes } from "./last-resort";
import { apiEndpoints } from "./api-endpoints";
import { outcomeFromApiError, reportAttempt } from "./attempts";
import { probeAddendum } from "./control-plane-probe";
import { newTrace, renderTrace, type EndpointTrace } from "./endpoint-trace";
import { setTokens } from "./session";
import { endCustomerSession, type SessionEnd } from "./session-end";
import { clearGamingProfileCache } from "./customer";
import { raceChallengeFor, solveQuietly, type Challenge, type Solution } from "./pow";
import { currentLanguage } from "./i18n";
import { deviceHeaders } from "./device-identity";
import { startSocialSignIn } from "./social-auth";
import type { SocialOutcome, SocialProvider } from "./social-auth";
import type { ApiResult, RequestFailure } from "./api";
import type { AttemptKind } from "./attempts";
import type { LoginResult, RequiresVerification, TokenPair, VerifyResult } from "./types";

/** Reports how a sign-up or sign-in went.
 *
 * Here rather than in the screens so there is exactly one place it can
 * be forgotten, and because the interesting distinction -- refused
 * versus never arrived -- is visible in the result rather than in the
 * component.
 *
 * Deliberately does not send the address. The endpoint accepts anonymous
 * reports, so an email in the body would be an unverified claim about a
 * real person, and these rows already hold an IP from somewhere it is
 * dangerous to hold one. A verified session attaches the customer
 * server-side; a failed sign-in has no session, and that is the honest
 * answer.
 *
 * An unreachable control plane carries the trace of what the request
 * tried -- each address, and whether it timed out, failed or was never
 * allowed -- as the pre-connect refresh's report does. Sign-in on a
 * filtered network is exactly when it is needed. `trace` is absent for a
 * failure that never reached `publicRequest` (a social provider that
 * refused), and then nothing is claimed about addresses at all.
 */
function reportAuth(kind: AttemptKind, result: ApiResult<unknown>, trace?: EndpointTrace): void {
  if (result.ok) {
    void reportAttempt({ kind, outcome: "SUCCESS" });
    return;
  }
  // `noResponse` first: a sign-in whose challenge was answered but whose
  // own request then was not is told so in its own words (see
  // `STOPPED_ANSWERING`), and it is still a request that never got an
  // answer. The sentence is the fallback for a failure that never went
  // through `publicRequest`, such as a social provider's.
  const outcome = result.noResponse ? "CONTROL_PLANE_UNREACHABLE" : outcomeFromApiError(result.error);
  if (outcome !== "CONTROL_PLANE_UNREACHABLE" || !trace) {
    void reportAttempt({ kind, outcome, reason: result.error });
    return;
  }
  // Made now, with the trace; the probe's answer follows it rather than
  // holding it back -- see `reportAttempt`. Nothing follows a failed
  // sign-in, so the path the probe sees is the one the request saw. See
  // control-plane-probe.ts.
  void reportAttempt(
    { kind, outcome, reason: result.error, apiEndpoint: renderTrace(trace) || "none dialled" },
    probeAddendum(trace.entries),
  );
}

/** How long a sign-in or sign-up may spend waiting on the network, all
 * told: 46.5 seconds.
 *
 * There was no limit. The challenge and the attempt were two walks over
 * the same list, eight seconds for every blocked address in each, and the
 * button sat on "Signing in..." for as long as that took: about three
 * minutes with everything blackholed, in a simulated network.
 *
 * Long enough for one slow route to finish the job. The challenge race
 * asks in stages a head start apart (`LEAD_MS`): the first address, then
 * the rest, then those that recently failed on this network, so the last
 * is asked at most two head starts in, and each gets `SLOW_ANSWER_MS`.
 * The attempt then gets up to that again at an address that answered
 * (`via` in api.ts), and three and a half seconds are left over.
 * A CDN that answers in about twenty seconds, with every mirror blocked,
 * still signs the customer in, even when it had failed here recently. A
 * network where nothing answers is told so after the race alone, without
 * waiting for this: a little over twenty seconds at most, and about
 * eleven and a half where no address even completes a connection
 * (`CONNECT_TIMEOUT_MS` in api.ts) -- thirteen when some of them were
 * asked a stage late -- and in moments where every name resolves to
 * Iran's block page (`resolvesToBlockPage`).
 *
 * Network time only (`NetworkDeadline`). The proof of work is solved with
 * the clock stopped: the server raises its difficulty as failures add up,
 * per account and per source address -- and behind a node's mirror the
 * source is the node's, shared by every customer on it -- and at the top
 * of that range a solve takes tens of seconds (`solve` in pow.ts). Counted
 * against this, a slow solve left nothing for the attempt, which was then
 * never sent, and the screen said Neoxify had stopped responding when it
 * had answered every request it was asked. */
const SIGN_IN_DEADLINE_MS = 2 * LEAD_MS + 2 * SLOW_ANSWER_MS + 3_500;

/** A deadline that runs only while it is told to: the sign-in's, which
 * stops while the proof of work is solved. Its signal fires once the time
 * it has run adds up to the whole. */
class NetworkDeadline {
  private readonly controller = new AbortController();
  private remaining: number;
  private runningSince: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(ms: number) {
    this.remaining = ms;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether the whole of it has been used. */
  get spent(): boolean {
    return this.controller.signal.aborted || (this.runningSince === null && this.remaining <= 0);
  }

  run(): void {
    if (this.runningSince !== null || this.spent) return;
    this.runningSince = Date.now();
    this.timer = setTimeout(() => this.controller.abort(), this.remaining);
  }

  pause(): void {
    if (this.runningSince === null) return;
    clearTimeout(this.timer);
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.runningSince));
    this.runningSince = null;
  }
}

/** Sends a sign-in or sign-up, with a proof-of-work solution, where the
 * challenge race says it will be answered.
 *
 * The challenge is raced across the endpoints (`raceChallengeFor`).
 * Nothing answering ends it there -- as Neoxify unreachable, or with the
 * status of the page that did answer -- and the attempt is not then walked
 * over the same dead list. Otherwise the attempt goes first to the address
 * that handed out the challenge. It has just shown it works, and the
 * server priced the challenge for the source address it saw there, which
 * is the one the attempt will arrive from too. Then it goes to the other
 * addresses the backend answered from. Never to one that answered only
 * with a page: the backend was not reached through it. It is still sent
 * to one address at a time, for the reasons `fetchAnyEndpoint` gives: the
 * solution is single use, and sign-in is throttled hard.
 *
 * If none of those answers the attempt, or only a page from in front of
 * the backend does, a fresh challenge is raced over the addresses not yet
 * heard from -- those the first race stopped, or never asked, because the
 * remembered address answered inside its head start -- and the attempt
 * goes where that one is answered, with the new solution (`mayTryAgain`
 * says when). The sign-in used to end there instead: the remembered
 * address answered the challenge, reset the sign-in or answered it with a
 * CDN's 521 or a WAF's 403 page, and the customer was told so while
 * another address would have signed them in. Every retry then did the
 * same, because only a timeout moves an address down the order. A fresh
 * challenge, because the first one's solution may have reached the server
 * with the attempt that got nothing back, and a second copy of it would
 * be refused as already used.
 *
 * The whole thing ends by `SIGN_IN_DEADLINE_MS` of network time. A page
 * that answered an attempt is the result if nothing better comes, because
 * something did answer. Otherwise, when the backend answered and then
 * nothing took the attempt, the result says Neoxify stopped responding; it
 * says that only when the backend itself answered, never because a page
 * from in front of it did.
 *
 * Solved before the attempt, not in response to being refused: the
 * server raises the required difficulty as failures accumulate, so
 * carrying a solution is what keeps sign-in usable once an address or an
 * account has drawn attention. */
async function sendWithChallenge<T>(
  path: string,
  email: string | undefined,
  init: (solution: Solution | undefined) => RequestInit,
  trace: EndpointTrace,
): Promise<ApiResult<T>> {
  const deadline = new NetworkDeadline(SIGN_IN_DEADLINE_MS);
  // Whether the backend itself answered a challenge race.
  let backendAnswered = false;
  // What the first race said when the backend did not answer it: Neoxify
  // unreachable, or a page's status.
  let failure: RequestFailure | undefined;
  // The first page that answered an attempt.
  let page: RequestFailure | undefined;
  // The addresses a later race need not ask: sent the attempt, answered
  // with a page, or silent.
  const heard = new Set<string>();
  // Which addresses the next race asks; the whole list the first time.
  let candidates: string[] | undefined;
  try {
    for (;;) {
      trace.phase = "challenge";
      deadline.run();
      const race = await raceChallengeFor("customer", email, trace, deadline.signal, candidates);
      deadline.pause();
      for (const base of [...race.answered.map((answered) => answered.base), ...race.pages, ...race.failed]) {
        heard.add(base);
      }
      if (race.answered.length === 0) {
        if (!backendAnswered) failure ??= race.failure;
        break;
      }
      backendAnswered = true;
      // With the clock stopped: see `SIGN_IN_DEADLINE_MS`.
      const solution = await solveQuietly(race.challenge);
      // Out of time before anything was sent: the attempt is not sent
      // with no time to be answered in.
      if (deadline.spent) break;
      trace.phase = "req";
      deadline.run();
      const result = await publicRequest<T>(path, { ...init(solution), signal: deadline.signal }, trace, race.answered);
      deadline.pause();
      // The backend's own answer, whatever it says, is the end of it.
      if (result.ok || !(result.noResponse || result.page)) return result;
      if (!mayTryAgain(path, result)) {
        if (result.page) return result;
        break;
      }
      if (result.page) page ??= result;
      if (deadline.spent) break;
      candidates = (await apiEndpoints()).filter((base) => !heard.has(base));
      if (candidates.length === 0) break;
    }
  } finally {
    deadline.pause();
  }
  if (page) return page;
  if (backendAnswered) return { ok: false, error: STOPPED_ANSWERING, noResponse: true };
  return failure ?? unreachable();
}

const SIGN_IN_PATH = "/customer-auth/login";

/** Whether an attempt that got `result` -- a page from in front of the
 * backend, or no answer at all -- is raced for a fresh challenge at the
 * addresses not yet heard from (`sendWithChallenge`).
 *
 * A sign-in, after either. A second copy of it creates nothing, and with a
 * fresh challenge it is not refused as a security check already used --
 * even after a gateway page that says the backend may have acted on the
 * first (`mayHaveReachedBackend` in api.ts), which used to end it.
 *
 * A sign-up only after a page that says the backend was never reached: a
 * CDN's 521, a WAF's 403, a fallback site's 404. Not after one that says
 * it may have been, nor after no answer at all, which is what a sign-up
 * the server took and then answered too slowly looks like -- the password
 * is hashed and the verification email sent before it answers. A second
 * copy with a new, valid solution was then told the email was already
 * registered, about the account the first copy had just made. Stopped
 * instead, it says Neoxify stopped responding, and the customer's next try
 * is told the truth either way. */
function mayTryAgain(path: string, result: RequestFailure): boolean {
  if (path === SIGN_IN_PATH) return true;
  return result.page === true && !mayHaveReachedBackend(result.status);
}

/** Never returns a usable session -- see RequiresVerification's doc
 * comment. The app must always follow this up by showing the verify
 * screen, never a dashboard. */
export async function register(email: string, password: string, referralCode?: string) {
  const trace = newTrace();
  const result = await sendWithChallenge<RequiresVerification>(
    "/customer-auth/register",
    undefined,
    (challenge) => ({
      method: "POST",
      // Omitted entirely when blank rather than sent as "": the backend
      // treats a supplied-but-wrong code as an error, and an empty string
      // is not a code somebody typed.
      body: JSON.stringify({
        email,
        password,
        // Read here rather than passed in by the screen, so the one call
        // site that creates an account cannot be the one that forgets.
        // The very first email this account receives is the verification
        // code, and it is sent before the customer has anywhere to tell
        // us anything -- so the language has to travel with the signup or
        // that email is in the wrong one no matter what happens later.
        locale: currentLanguage(),
        ...(referralCode ? { referralCode } : {}),
        ...(challenge ? { challenge } : {}),
      }),
    }),
    trace,
  );
  reportAuth("REGISTER", result, trace);
  // Every ordinary route failed as only blocking explains: the backup
  // route's own sign-up is offered instead (`relayRegister`). Not this
  // sign-up sent through it -- that one mails a code the customer may
  // have no way to read. Nothing is sent to the relay to decide this.
  if (!result.ok && everyRouteFailed(result, trace) && (await relaySignupOffered())) {
    return { ...result, relaySignup: true as const };
  }
  return result;
}

/** A relay sign-up's answer: the session, and the recovery code shown
 * once (docs/relay-last-resort.md, R3.2). */
export interface RelaySignup {
  accessToken: string;
  refreshToken: string;
  recoveryCode: string;
  relayUnverified: true;
}

/** Signing up through the relay of last resort, without email
 * verification (R3).
 *
 * Only through the relay: the backend answers this path nowhere else. The
 * address is typed twice, since nothing confirms it (F9); the proof of
 * work is the relay's own, harder one (`relay-signup`), priced by the
 * backend for the caller and, advisorily, this install. On success the
 * session is stored at once -- the account is usable, limited to an
 * Ultimate voucher until the address is confirmed -- and the recovery
 * code comes back for the screen to show, once. Consent is asked first
 * if it never was (last-resort.ts). */
export async function relayRegister(
  email: string,
  emailConfirm: string,
  password: string,
): Promise<ApiResult<{ recoveryCode: string }>> {
  const unavailable: RequestFailure = { ok: false, error: "The backup route can't be used right now.", code: "RELAY_UNAVAILABLE" };
  const challenge = await relayOnly<Challenge>(
    "/login-challenge",
    { method: "POST", body: JSON.stringify({ scope: "relay-signup" }), headers: relayInstallHeaders() },
    "foreground",
  );
  if (challenge === null) return unavailable;
  if (!challenge.ok) return challenge;
  const solution = await solveQuietly(challenge.data);
  const result = await relayOnly<RelaySignup>(
    "/customer-auth/relay-register",
    {
      method: "POST",
      body: JSON.stringify({
        email,
        emailConfirm,
        password,
        locale: currentLanguage(),
        ...(solution ? { challenge: solution } : {}),
      }),
      headers: { ...deviceHeaders(), ...relayInstallHeaders() },
    },
    "foreground",
  );
  if (result === null) return unavailable;
  if (!result.ok) return result;
  // As `login()` does: no previous customer's entitlement survives into
  // this one's session.
  clearGamingProfileCache();
  await setTokens({ accessToken: result.data.accessToken, refreshToken: result.data.refreshToken });
  return { ok: true, data: { recoveryCode: result.data.recoveryCode } };
}

/** A sign-in through the relay of last resort, after every ordinary route
 * failed (`everyRouteFailed`) or while relay mode says they will.
 *
 * Sent to the relay alone and one step at a time, as a sign-in is
 * everywhere: the challenge, then the attempt with its solution. An
 * unverified account signing in from Iran this way is let in on a relay
 * sign-up's terms (R4.2), which asks for that sign-up's harder proof of
 * work: the backend says so with `CHALLENGE_REQUIRED` and scope
 * `relay-signup`, and the attempt is made once more with one. Null when
 * the relay was not dialled -- switched off, no relay, the budget -- so the
 * caller keeps the ordinary routes' own failure, or asks them. Null too
 * when the backend refused the relay for this network's region
 * (`refusedForRegion` in api.ts): the customer did not choose the relay,
 * and what failed is the ordinary routes. Runs on the relay's own clock
 * (`RELAY_CALL_MS` a call), which is how the sign-in's deadline grows by
 * the relay's budget. */
async function relaySignIn(
  email: string,
  password: string,
  normal?: RequestFailure,
): Promise<ApiResult<LoginResult> | null> {
  const challenge = await relayOnly<Challenge>(
    "/login-challenge",
    { method: "POST", body: JSON.stringify({ scope: "customer", email }) },
    "foreground",
    normal,
  );
  if (challenge === null || refusedForRegion(challenge)) return null;
  if (!challenge.ok) return challenge;
  const attempt = async (solution: Solution | undefined) =>
    (await relayOnly<LoginResult>(
      SIGN_IN_PATH,
      {
        method: "POST",
        body: JSON.stringify({ email, password, ...(solution ? { challenge: solution } : {}) }),
        headers: deviceHeaders(),
      },
      "foreground",
      normal,
    )) ?? { ...(normal ?? unreachable()), relayTried: true as const };
  let result = await attempt(await solveQuietly(challenge.data));
  if (!result.ok && result.code === "CHALLENGE_REQUIRED" && relayScope(result.body) === "relay-signup") {
    const harder = await relayOnly<Challenge>(
      "/login-challenge",
      { method: "POST", body: JSON.stringify({ scope: "relay-signup" }), headers: relayInstallHeaders() },
      "foreground",
      normal,
    );
    if (harder !== null && refusedForRegion(harder)) return null;
    if (harder === null || !harder.ok) return harder ?? result;
    result = await attempt(await solveQuietly(harder.data));
  }
  return refusedForRegion(result) ? null : result;
}

/** The `scope` a CHALLENGE_REQUIRED refusal names, if any. */
function relayScope(body: unknown): string | undefined {
  const scope = body !== null && typeof body === "object" ? (body as { scope?: unknown }).scope : undefined;
  return typeof scope === "string" ? scope : undefined;
}

/** Only stores a session when the account is actually verified --
 * `requiresVerification` results are never persisted, so an unverified
 * account can't end up with stray tokens sitting in the store. */
export async function login(email: string, password: string) {
  const trace = newTrace();
  const ordinary = () =>
    sendWithChallenge<LoginResult>(
      "/customer-auth/login",
      // The email is sent with the challenge request so the server can
      // price this attempt against that account's own recent failures --
      // the case per-address rate limiting cannot see.
      email,
      (challenge) => ({
        method: "POST",
        body: JSON.stringify({ email, password, ...(challenge ? { challenge } : {}) }),
        // Names this device to the customer's others ("Neoxify is in use on
        // a Windows PC"). See device-identity.ts.
        headers: deviceHeaders(),
      }),
      trace,
    );
  // The relay of last resort, never raced: after the ordinary routes have
  // all failed as only blocking explains, or first while relay mode says
  // they will and they are not due to be asked again (last-resort.ts).
  let result: ApiResult<LoginResult>;
  if (skipNormalRoutes()) {
    const relayed = await relaySignIn(email, password);
    // Not dialled, unanswered there, or held by a tunnel that may well
    // carry the ordinary routes: those are asked after all.
    const fellThrough =
      relayed === null || (!relayed.ok && (relayed.code === "RELAY_DISCONNECT" || (relayed.relayTried && relayed.noResponse)));
    if (!fellThrough) result = relayed;
    else {
      result = await ordinary();
      if (!result.ok && relayed !== null && !relayed.ok && relayed.relayTried) result = { ...result, relayTried: true };
    }
  } else {
    result = await ordinary();
    if (!result.ok && everyRouteFailed(result, trace)) result = (await relaySignIn(email, password, result)) ?? result;
  }
  if (result.ok && !("requiresVerification" in result.data)) {
    // Before the tokens, not after. From here on any fetch is this
    // customer's, and a cache entry still holding the previous one's
    // entitlement would be read as belonging to the session that just
    // started. Sign-out clears this too; doing it here as well covers
    // the sign-ins that never pass through a sign-out at all -- the
    // auto-sign-in after email verification is three separate call
    // sites, none of which ends a prior session.
    clearGamingProfileCache();
    await setTokens(result.data);
  }
  // After the tokens are stored, so a successful sign-in is attributed
  // to the customer it belongs to rather than arriving anonymous.
  reportAuth("SIGN_IN", result, trace);
  return result;
}

/** Signing in with Google, Apple or Facebook.
 *
 * Deliberately the same shape as `login()` above, including the cache
 * clear and the attempt report, because everything downstream of a
 * session must not be able to tell how it was obtained. The difference
 * is only in how the credential is obtained, which is social-auth.ts's
 * problem, and which endpoint finishes it.
 *
 * Returns `null` when the customer cancelled -- distinct from a failed
 * result, because a cancellation has nothing to report and nothing to
 * show.
 *
 * `signal` cancels it: the Cancel beside the buttons, or the screen going
 * away. Once it has fired no session is stored, whatever comes back. On
 * Windows the browser cannot be watched, so the flow used to wait out its
 * five minutes; a customer who gave up and signed in with email meanwhile
 * could then have a late Google sign-in put another account's tokens
 * under the dashboard they were already using.
 */
export async function socialSignIn(
  provider: SocialProvider,
  signal?: AbortSignal,
): Promise<ApiResult<TokenPair> | null> {
  const locale = currentLanguage();

  let outcome: SocialOutcome | null;
  try {
    outcome = await startSocialSignIn(provider, locale, signal);
  } catch (err) {
    // A provider that refused, a browser that would not open, a message
    // the server wrote for this customer. None of these reached an
    // endpoint, so there is no ApiResult -- but the screen still needs
    // something to show, and reportAuth still wants to know it failed.
    const error = err instanceof Error ? err.message : String(err);
    const result: ApiResult<TokenPair> = { ok: false, error };
    reportAuth("SIGN_IN", result);
    return result;
  }
  if (outcome === null || signal?.aborted) return null;

  const trace = newTrace();
  const result =
    outcome.kind === "apple-token"
      ? await publicRequest<TokenPair>(
          "/customer-auth/social",
          {
            method: "POST",
            body: JSON.stringify({ provider, token: outcome.token, locale }),
            headers: deviceHeaders(),
            relay: "foreground",
          },
          trace,
        )
      : await exchangeHandoff(outcome.code, outcome.verifier, trace);

  // Cancelled while the exchange ran: the session it collected is not
  // stored. It is one unused session on the server, which lapses.
  if (signal?.aborted) return null;
  if (result.ok) {
    // Same reasoning as login(): before the tokens, so a stale
    // entitlement from the previous customer is never read as this
    // one's.
    clearGamingProfileCache();
    await setTokens(result.data);
  }
  reportAuth("SIGN_IN", result, trace);
  return result;
}

/** The web portal's end of a Google or Facebook sign-in: the page came
 * back from the provider with a handoff code, and holds the verifier of
 * the PKCE pair it left with (apps/web-portal/src/auth/social-web.ts).
 *
 * Everything after the provider trip is socialSignIn()'s, unchanged: the
 * same exchange, the cache cleared before the tokens are stored, the same
 * attempt report. The portal has no browser of its own to wait on -- it
 * WAS the browser, and left -- so it cannot call socialSignIn() itself. */
export async function collectSocialHandoff(code: string, verifier: string): Promise<ApiResult<TokenPair>> {
  const trace = newTrace();
  const result = await exchangeHandoff(code, verifier, trace);
  if (result.ok) {
    clearGamingProfileCache();
    await setTokens(result.data);
  }
  reportAuth("SIGN_IN", result, trace);
  return result;
}

/** What a backend from before the PKCE binding says to an exchange that
 * carries a verifier: its validation forbids any property its DTO does
 * not declare, and that refusal is worded by class-validator, not by us.
 * A backend with the binding declares `verifier` and never says it. */
const VERIFIER_UNKNOWN = /\bproperty verifier should not exist\b/;

/** Google and Facebook finished on the server; this only collects the
 * session it is already holding -- with the verifier for the PKCE
 * challenge the flow started with, without which the server will not
 * hand over a session bound to it (social-auth.ts).
 *
 * Once more without the verifier, but only when the server refused the
 * field itself. That is a backend from before the binding, and without
 * this a client released ahead of that backend's deploy could not finish
 * Google or Facebook sign-in at all -- which also meant main could not
 * cut a client hotfix until the backend had gone out. It reopens
 * nothing:
 *  - that backend's validation ran before its handler, so the code was
 *    never looked at, let alone spent, and that backend binds nothing --
 *    the retry asks for exactly what every released client asks for;
 *  - a backend with the binding never words a refusal this way, and it
 *    spends the code before checking the verifier, so even a retry it
 *    provoked could collect nothing.
 * Any other refusal -- an expired code, a wrong verifier -- is final. */
async function exchangeHandoff(
  code: string,
  verifier: string | undefined,
  trace: EndpointTrace,
): Promise<ApiResult<TokenPair>> {
  const exchange = (body: { code: string; verifier?: string }) =>
    publicRequest<TokenPair>(
      "/customer-auth/social/exchange",
      { method: "POST", body: JSON.stringify(body), relay: "foreground" },
      trace,
    );
  if (!verifier) return exchange({ code });
  const result = await exchange({ code, verifier });
  if (!result.ok && result.status === 400 && VERIFIER_UNKNOWN.test(result.error)) {
    return exchange({ code });
  }
  return result;
}

export async function verifyEmailByCode(email: string, code: string) {
  return publicRequest<VerifyResult>("/customer-auth/verify-email-code", {
    method: "POST",
    body: JSON.stringify({ email, code }),
    relay: "foreground",
  });
}

/** The token-based counterpart to verifyEmailByCode -- used when the
 * "Open in Neoxify" link in the verification email actually launches
 * the app (see the deep-link handling in App.tsx). No password is ever
 * available at this point (a cold app launch via a clicked email link,
 * not a live register/login session), so this can't auto-sign-in the way
 * the code flow does -- the caller sends the user to a normal sign-in
 * afterward. */
export async function verifyEmailByToken(token: string) {
  return publicRequest<VerifyResult>("/customer-auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function resendVerification(email: string) {
  return publicRequest<void>("/customer-auth/resend-verification", {
    method: "POST",
    body: JSON.stringify({ email }),
    relay: "foreground",
  });
}

/** How long a sign-out waits for the server to hear about it.
 *
 * The request is a write, so it goes to the address the backend last
 * answered from, or else asks who answers first (`sendWrite` in api.ts):
 * on a filtered network that can take twenty seconds or more, and the
 * tunnel stays up for all of it, because the tunnel comes down after this
 * call and not before. Eight seconds is what the customer waits; the
 * request carries on unwatched after that. */
const LOGOUT_SERVER_BUDGET_MS = 8_000;

export async function logout(): Promise<SessionEnd> {
  // The server call goes first, while the tunnel is still up: on a
  // filtered network the tunnel is the likeliest route to the control
  // plane, and this is what revokes the refresh token there.
  // Through the relay too, without asking (F17): an unverified account
  // holds three sessions, and one that cannot sign out holds one for a
  // month. The tunnel gate keeps it off the relay while a tunnel is up.
  const told = apiRequest<void>("/customer-auth/logout", { method: "POST", relay: "background" }).catch(
    () => undefined,
  );
  await Promise.race([told, new Promise((r) => setTimeout(r, LOGOUT_SERVER_BUDGET_MS))]);
  // And this runs regardless of what it said: a sign-out the network
  // refused is still a sign-out on this machine, and leaving the tunnel
  // up, or the previous customer's credentials and entitlement behind,
  // because a request failed is the wrong way to fail.
  return await endCustomerSession();
}

/** Deletes the signed-in customer's own account, permanently.
 *
 * Required to exist by both app stores for any app that offers account
 * creation -- Apple 5.1.1(v) and Play's data deletion policy -- so this
 * is a condition of being listed, not a courtesy.
 *
 * The server revokes every credential on every node before it returns,
 * and bumps the token version so any other signed-in device stops
 * working too. Local tokens are cleared afterwards regardless of what
 * the server said: if the account really is gone, keeping them would
 * leave the app trying to use credentials that can only fail, and if the
 * call failed the worst outcome is one unnecessary sign-in.
 *
 * Returns how many credentials were revoked, which the caller can show
 * -- the customer deserves to know their access is actually gone rather
 * than being told it is.
 */
export async function deleteAccount() {
  const result = await apiRequest<{ deleted: boolean; credentialsRevoked: number }>("/customer/me", {
    method: "DELETE",
  });
  // The whole teardown, not just the tokens. An account that no longer
  // exists has no business leaving its WireGuard keys and its cached
  // entitlement on the machine -- and this path never went through
  // `Dashboard.handleLogout`, which was the only caller of
  // `clearSnapshot` before.
  await endCustomerSession();
  return result;
}

/** Changes the password of the signed-in customer.
 *
 * The backend revokes every session on success, including this app's own,
 * so it hands back a fresh pair -- storing them immediately is what keeps
 * the user signed in instead of being bounced to the login screen on
 * their next request. */
export async function changePassword(currentPassword: string, newPassword: string) {
  const result = await apiRequest<TokenPair>("/customer-auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
    relay: "foreground",
  });
  if (result.ok) {
    await setTokens(result.data);
  }
  return result;
}

/** Asks for a reset code by email.
 *
 * Always succeeds from the caller's point of view, whether or not the
 * address belongs to an account -- the server deliberately answers the
 * same either way so this cannot be used to find out who has one. The UI
 * must therefore say "if that address is registered", never "sent".
 */
export async function forgotPassword(email: string) {
  return publicRequest<void>("/customer-auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
    relay: "foreground",
  });
}

/** Completes the reset with the emailed code.
 *
 * The code rather than the token, for the same reason verifyEmailByCode
 * exists: the token only ever arrives inside a link, and webmail strips
 * the custom URI scheme those links use, so a desktop client cannot rely
 * on receiving one.
 */
export async function resetPasswordByCode(email: string, code: string, newPassword: string) {
  return publicRequest<void>("/customer-auth/reset-password-code", {
    method: "POST",
    body: JSON.stringify({ email, code, newPassword }),
    relay: "foreground",
  });
}

/** Resets the password with the recovery code: the way back in when the
 * mailbox cannot be reached (docs/relay-last-resort.md, R4.3). The code is
 * spent, and a new one comes back, to be shown once. */
export async function resetPasswordByRecoveryCode(email: string, recoveryCode: string, newPassword: string) {
  return publicRequest<{ recoveryCode: string }>("/customer-auth/reset-password-recovery", {
    method: "POST",
    body: JSON.stringify({ email, recoveryCode, newPassword }),
    relay: "foreground",
  });
}

/** Creates or replaces the signed-in customer's recovery code, returned
 * once (R4.3). The current password re-authenticates; an account without
 * one passes none, and the backend asks for a sign-in from the last
 * fifteen minutes instead (`REAUTH_REQUIRED`). */
export async function createRecoveryCode(currentPassword: string | undefined) {
  return apiRequest<{ recoveryCode: string }>("/customer-auth/recovery-code", {
    method: "POST",
    body: JSON.stringify(currentPassword ? { currentPassword } : {}),
    relay: "foreground",
  });
}

/** Gives a Google, Apple or Facebook account a password, so it can still
 * sign in when those cannot be reached (R4.4). On a sign-in from the last
 * fifteen minutes (`REAUTH_REQUIRED` otherwise). */
export async function setPassword(newPassword: string) {
  return apiRequest<void>("/customer-auth/set-password", {
    method: "POST",
    body: JSON.stringify({ newPassword }),
    relay: "foreground",
  });
}

/** Corrects an address that has not been confirmed (F9): password, the
 * new address twice, three a day. The backend hands back fresh tokens,
 * since the old ones carry the old address. */
export async function changeUnverifiedEmail(email: string, emailConfirm: string, password: string) {
  const result = await apiRequest<TokenPair>("/customer-auth/unverified-email", {
    method: "POST",
    body: JSON.stringify({ email, emailConfirm, password }),
    relay: "foreground",
  });
  if (result.ok) await setTokens(result.data);
  return result;
}
