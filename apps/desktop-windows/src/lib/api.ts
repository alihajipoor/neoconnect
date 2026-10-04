import { fetch } from "@tauri-apps/plugin-http";
import { apiEndpoints, rememberEndpoint } from "./api-endpoints";
import { maybeRefreshBundle } from "./endpoint-bundle-store";
import { clearTokens, getTokens, setTokens } from "./session";
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
 */
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
 * first address and never tried the rest. That path is a GET and still
 * races; nothing here is inside a shorter budget.
 */
async function fetchOneEndpointAtATime(
  path: string,
  init: RequestInit,
  endpoints: string[],
): Promise<Response> {
  let lastError: unknown;
  for (const base of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
      void rememberEndpoint(base);
      void maybeRefreshBundle(base);
      return response;
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("no API endpoint answered");
}

async function fetchAnyEndpoint(path: string, init: RequestInit): Promise<Response> {
  const endpoints = await apiEndpoints();
  if (endpoints.length === 0) throw new Error("no API endpoint is configured");

  // Raced, not walked, and the sequential version is why Windows
  // customers could not connect on networks where Android could.
  //
  // Each endpoint used to get its own ENDPOINT_TIMEOUT_MS of 8 seconds,
  // tried one after another, with the comment explaining that a single
  // hanging address must not consume the budget. The arithmetic went the
  // other way: the pre-connect config refresh wraps this in a 6 second
  // budget (REFRESH_BUDGET_MS), which is *shorter* than one endpoint's
  // timeout -- so if the first address did not answer, the budget
  // expired inside it and the other seven were never tried at all. One
  // blocked address meant the refresh always failed.
  //
  // It bit Windows and not Android because the lists differ in length.
  // The desktop build bakes in a seed bundle of eight endpoints and puts
  // them ahead of the compiled-in base; the mobile build has no seed, so
  // its first address is the one that works. Same code, same network,
  // opposite outcome -- and 162 CONTROL_PLANE_UNREACHABLE reports from
  // Windows in thirty days against 43 from Android.
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
    return await fetchOneEndpointAtATime(path, init, endpoints);
  }

  const controllers = endpoints.map(() => new AbortController());
  const timers = controllers.map((c) => setTimeout(() => c.abort(), ENDPOINT_TIMEOUT_MS));

  const attempts = endpoints.map(async (base, i) => {
    const response = await fetch(`${base}${path}`, { ...init, signal: controllers[i].signal });
    // Only a real answer counts as a win. A request that fails rejects,
    // and Promise.any moves on to whichever endpoint actually replied.
    return { base, response };
  });

  try {
    const { base, response } = await Promise.any(attempts);

    // Everyone else can stop; the answer is in hand.
    controllers.forEach((c, i) => {
      if (endpoints[i] !== base) c.abort();
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
  }
}

/** The failure half of every result shape below.
 *
 * Named because two result unions share it verbatim, and a caller that
 * has narrowed on `ok === false` must read the same way whichever
 * request function produced it. */
export type RequestFailure = { ok: false; error: string; sessionExpired?: boolean };

export type ApiResult<T> = { ok: true; data: T } | RequestFailure;

/** The one sentence a transport failure is allowed to produce.
 *
 * A fresh object each time rather than a shared constant, so a caller
 * that stashes a result can never mutate the message every other caller
 * is about to read. */
const unreachable = (): RequestFailure => ({
  ok: false,
  error: "Could not reach Neoxify. Check your internet connection.",
});

async function parseErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  if (Array.isArray(body?.message)) return body.message.join(", ");
  if (typeof body?.message === "string") return body.message;
  return `Request failed (${res.status})`;
}

/** Unauthenticated request -- login/register don't have a token yet. */
export async function publicRequest<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetchAnyEndpoint(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    return unreachable();
  }

  if (!res.ok) {
    return { ok: false, error: await parseErrorMessage(res) };
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: (await res.json()) as T };
}

async function refreshTokens(): Promise<TokenPair | null> {
  const current = await getTokens();
  if (!current) return null;

  const result = await publicRequest<TokenPair>("/customer-auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: current.refreshToken }),
  });
  if (!result.ok) return null;

  await setTokens(result.data);
  return result.data;
}

/** Either a real HTTP response, or a failure already phrased for the
 * customer. Deliberately not an `ApiResult`: the status still has to be
 * interpreted, and each caller below interprets it differently. */
type Attempt = { answered: true; res: Response } | { answered: false; failure: RequestFailure };

/** Everything an authenticated request does *around* the response:
 * attach the stored access token, and on a 401 (expired access token,
 * the normal case ~every 15 minutes) try exactly one silent
 * refresh-and-retry before giving up. If the refresh itself fails
 * (revoked/expired refresh token), clear the stored session and report
 * `sessionExpired: true` so the UI can drop back to the login screen
 * instead of showing a raw error.
 *
 * Split out from `apiRequest` so a second interpretation of the
 * response -- conditional requests, below -- cannot drift from this one.
 * Every failure mode is a `RequestFailure` here rather than a thrown
 * error, so no caller can accidentally let one pass as success. */
async function authenticatedAttempt(path: string, init?: RequestInit): Promise<Attempt> {
  const tokens = await getTokens();
  if (!tokens) {
    return { answered: false, failure: { ok: false, error: "Not signed in.", sessionExpired: true } };
  }

  const doFetch = (accessToken: string) =>
    fetchAnyEndpoint(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...init?.headers,
      },
    });

  let res: Response;
  try {
    res = await doFetch(tokens.accessToken);
  } catch {
    return { answered: false, failure: unreachable() };
  }

  if (res.status === 401) {
    const refreshed = await refreshTokens();
    if (!refreshed) {
      await clearTokens();
      return {
        answered: false,
        failure: { ok: false, error: "Your session expired. Please sign in again.", sessionExpired: true },
      };
    }
    try {
      res = await doFetch(refreshed.accessToken);
    } catch {
      return { answered: false, failure: unreachable() };
    }
  }

  return { answered: true, res };
}

/** Authenticated request. See `authenticatedAttempt` for the token and
 * refresh handling; this adds the body. */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const attempt = await authenticatedAttempt(path, init);
  if (!attempt.answered) return attempt.failure;
  const res = attempt.res;

  if (!res.ok) {
    return { ok: false, error: await parseErrorMessage(res) };
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
    return { ok: false, error: await parseErrorMessage(res) };
  }
  const next = readEtag(res);
  if (res.status === 204) return { ok: true, notModified: false, data: undefined as T, etag: next };
  return { ok: true, notModified: false, data: (await res.json()) as T, etag: next };
}
