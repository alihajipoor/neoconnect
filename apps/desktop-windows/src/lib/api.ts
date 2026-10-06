import { fetch } from "@tauri-apps/plugin-http";
import { apiEndpoints, rememberEndpoint } from "./api-endpoints";
import { deviceHeaders } from "./device-identity";
import { maybeRefreshBundle } from "./endpoint-bundle-store";
import { beginAttempt, failureOutcome, settleAttempt, type EndpointTrace } from "./endpoint-trace";
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
 */
const ENDPOINT_TIMEOUT_MS = 8_000;

/** Walks the endpoints, one at a time, and returns the first that answers.
 *
 * The shape every request had before 0.9.39, kept for the ones that must
 * not be duplicated. "Answers" means the transport completed -- any HTTP
 * status counts, because a 401 is the server telling us the password was
 * wrong and must not send us looking for a mirror that says something
 * nicer.
 *
 * Each address gets its own `ENDPOINT_TIMEOUT_MS`. That was a real
 * problem for the pre-connect config refresh, whose own budget is
 * shorter than one endpoint's timeout, so the refresh expired inside the
 * first address and never tried the rest. Its GET now races. But this
 * walk is still inside that budget sometimes: once the access token has
 * expired -- it lives fifteen minutes, and the refresh only runs on a
 * snapshot over ten minutes old, so after any real idle it has -- the
 * GET's 401 sends the token refresh, a POST, through here before the
 * GET is retried. The endpoint trace records which leg
 * the budget ran out in; nothing about the walk itself is changed on the
 * strength of that reading alone.
 */
async function fetchOneEndpointAtATime(
  path: string,
  init: RequestInit,
  endpoints: string[],
  trace?: EndpointTrace,
): Promise<Response> {
  let lastError: unknown;
  // A caller's own signal, when it brought one. Each endpoint still gets
  // its own controller and timeout; the caller's only ever shortens that,
  // and once it has fired no further endpoint is tried. Without this a
  // request with a budget of its own -- the device-slot release, which
  // must be over in a second and a half -- walked every mirror at eight
  // seconds each regardless.
  const outer = init.signal ?? null;
  for (const base of endpoints) {
    if (outer?.aborted) break;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ENDPOINT_TIMEOUT_MS);
    const entry = beginAttempt(trace, base);
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener("abort", onOuterAbort);
    try {
      const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
      settleAttempt(entry, `h${response.status}`);
      void rememberEndpoint(base);
      void maybeRefreshBundle(base);
      return response;
    } catch (err) {
      settleAttempt(entry, timedOut ? "timeout" : failureOutcome(err));
      lastError = err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }
  throw lastError ?? new Error(outer?.aborted ? "the request ran out of time" : "no API endpoint answered");
}

/** Sends one request, trying each known endpoint until one answers.
 *
 * "Answers" means a real HTTP response, whatever its status. A 401 or a
 * 500 proves the endpoint is reachable and is the service -- moving on
 * would be wrong, and would turn one rejected password into a walk
 * through every mirror. Only a transport failure, which is what a
 * blocked address looks like, rotates to the next.
 *
 * Throws if none answered, so the callers below keep their existing
 * "could not reach Neoxify" handling unchanged.
 *
 * `trace`, when given, is told about every address tried and how each
 * attempt ended -- see endpoint-trace.ts. It changes nothing about which
 * addresses are tried or for how long.
 */
async function fetchAnyEndpoint(path: string, init: RequestInit, trace?: EndpointTrace): Promise<Response> {
  const endpoints = await apiEndpoints();
  if (endpoints.length === 0) throw new Error("no API endpoint is configured");
  // A caller whose deadline has already passed gets nothing sent on its
  // behalf, by either path below.
  if (init.signal?.aborted) throw new Error("the request ran out of time");

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
  // round trip rather than in however many dead addresses precede the
  // live one. A config refresh is a handful of small GETs; running them
  // together is well within what the network and the service will carry.
  // Raced only when racing is safe, which means only when the request
  // can be sent more than once without the server minding.
  //
  // A race sends the request to *every* mirror. For a config GET that is
  // the whole point. For a sign-in it means one click becomes eleven
  // login attempts, and that breaks login in two ways at once. The
  // proof-of-work challenge is single-use, so the first request to
  // arrive spends it and the server answers the rest with 400 "this
  // security check was already used" -- refused before any password
  // hashing, so those 400s come back *faster* than the one real answer
  // and win the race. And the endpoint is throttled at five attempts a
  // minute per address, so a single click is already over budget and
  // starts collecting 429s.
  //
  // So anything that is not a plain read goes to one endpoint at a
  // time, which is what 0.9.38 did for every request and what sign-in
  // has always needed. The endpoint list and its failover are
  // unchanged -- a blocked address still steps to the next one -- it is
  // only the simultaneity that is withdrawn, and only where it was
  // never safe.
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return await fetchOneEndpointAtATime(path, init, endpoints, trace);
  }

  const controllers = endpoints.map(() => new AbortController());
  // Which aborts were our own deadline, so the trace can say "timeout"
  // rather than the generic transport failure the abort surfaces as.
  const timedOut = endpoints.map(() => false);
  const timers = controllers.map((c, i) =>
    setTimeout(() => {
      timedOut[i] = true;
      c.abort();
    }, ENDPOINT_TIMEOUT_MS),
  );
  const entries = endpoints.map((base) => beginAttempt(trace, base));
  // The caller's signal stops every runner at once. See
  // fetchOneEndpointAtATime for why a caller may bring one.
  const outer = init.signal ?? null;
  const onOuterAbort = () => controllers.forEach((c) => c.abort());
  if (outer?.aborted) onOuterAbort();
  outer?.addEventListener("abort", onOuterAbort);

  const attempts = endpoints.map(async (base, i) => {
    try {
      const response = await fetch(`${base}${path}`, { ...init, signal: controllers[i].signal });
      settleAttempt(entries[i], `h${response.status}`);
      // Only a real answer counts as a win. A request that fails rejects,
      // and Promise.any moves on to whichever endpoint actually replied.
      return { base, response };
    } catch (err) {
      settleAttempt(entries[i], timedOut[i] ? "timeout" : failureOutcome(err));
      throw err;
    }
  });

  try {
    const { base, response } = await Promise.any(attempts);

    // Everyone else can stop; the answer is in hand. Marked as stopped
    // before the abort lands, so the trace reads "cancel" and not as a
    // failure of an address that may have been about to answer.
    controllers.forEach((c, i) => {
      if (endpoints[i] !== base) {
        settleAttempt(entries[i], "cancel");
        c.abort();
      }
    });

    // Remembered so the next request starts here. With a race this is no
    // longer about avoiding a timeout -- it is about not opening eight
    // connections for every request once a good address is known.
    void rememberEndpoint(base);
    // The endpoint answered, so it can also serve the next address list.
    // This is the only trigger the bundle has; without it a published
    // rotation never reaches a single client.
    void maybeRefreshBundle(base);
    return response;
  } catch (err) {
    // Nothing won, so there is no body anyone is still reading and
    // every straggler can be cut loose here.
    controllers.forEach((c) => c.abort());
    // AggregateError when every endpoint failed. Its `errors` carries
    // one entry per address, which is more than the caller needs, so the
    // first is surfaced to keep the existing "could not reach Neoxify"
    // handling unchanged.
    const first =
      err instanceof AggregateError ? (err.errors as unknown[])[0] : err;
    throw first ?? new Error("no API endpoint answered");
  } finally {
    // Timers only. Aborting every controller here is what broke login
    // in 0.9.39: `return response` runs this block *before* the value
    // reaches the caller, so the winner was aborted along with the
    // losers -- while its body was still unread. `Promise.any` resolves
    // when the headers arrive, not when the body does, so the caller's
    // `response.json()` was left waiting on a stream that had just been
    // cancelled. The sign-in button sat on "Signing in..." for ever and
    // nginx recorded 499 for the winning request as well as the losing
    // ones, because the client had indeed hung up first.
    //
    // The losers are already aborted in the success path above, where
    // the winner is known and can be spared.
    timers.forEach(clearTimeout);
    // Detached for the same reason: a caller's signal firing after the
    // answer is in hand must not cancel a body still being read.
    outer?.removeEventListener("abort", onOuterAbort);
  }
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
   * described as "could not reach Neoxify".
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
 * `trace` records which addresses were tried; see endpoint-trace.ts. */
export async function publicRequest<T>(path: string, init?: RequestInit, trace?: EndpointTrace): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetchAnyEndpoint(
      path,
      {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      },
      trace,
    );
  } catch {
    return unreachable();
  }

  if (!res.ok) {
    return await failureFrom(res);
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: (await res.json()) as T };
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
 * request. */
const REFRESH_REFUSED = 401;

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

  const result = await publicRequest<TokenPair>(
    "/customer-auth/refresh",
    {
      method: "POST",
      body: JSON.stringify({ refreshToken: current.refreshToken }),
      // What this device is called on the customer's other devices
      // ("Neoxify is in use on a Windows PC"). Sent on every refresh because
      // a session started in the system browser could not send it, and its
      // first refresh is what names that device. See device-identity.ts.
      headers: deviceHeaders(),
    },
    trace,
  );
  if (!result.ok) {
    return result.status === REFRESH_REFUSED ? { kind: "refused" } : { kind: "unavailable" };
  }

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
  } catch {
    return { answered: false, failure: unreachable() };
  }

  if (res.status === 401) {
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
    } catch {
      return { answered: false, failure: unreachable() };
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
