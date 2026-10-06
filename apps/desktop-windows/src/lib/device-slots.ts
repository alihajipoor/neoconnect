import { apiRequest, type ApiResult, type RequestFailure } from "./api";
import { outcomeFromError, type AttemptReport } from "./attempts";
import { deviceHeaders } from "./device-identity";

/** The device-slot calls: claim, renew, release.
 *
 * A plan's device limit is how many of the customer's devices may *use
 * the VPN at the same time* (owner decision, 2026-10-06). The app claims
 * a slot before it dials, renews it while connected, and releases it on
 * Disconnect. The contract is docs/device-slots.md; this file is its
 * client half, and the only place the HTTP shapes are read.
 *
 * Every answer is turned into one of a few outcomes here, so no screen
 * reads a status code. The rule they all serve: **the control plane is
 * never a precondition for connecting.** Exactly three answers stop a
 * dial: 409 `DEVICE_LIMIT`, 409 `SUBSCRIPTION_INACTIVE` and 429
 * `TAKEOVER_LIMIT`. Anything else -- no answer in time, a network error,
 * a 5xx, a 409 or 429 without one of those codes, an endpoint an old
 * backend does not have -- is `unanswered`, and the app dials anyway; a
 * renewal that is not a 200 keeps the tunnel. Somebody in Iran who cannot
 * reach the API must never lose the VPN over this.
 *
 * Shared with the mobile client through its `@shared` alias.
 */

/** How long a claim may hold up a connect before the app dials anyway. */
export const CLAIM_BUDGET_MS = 3_000;
/** A claim made once the tunnel is up, through it. Nothing is waiting on
 * this one but the renewal clock, so it can afford a little longer. */
export const LATE_CLAIM_BUDGET_MS = 6_000;
/** A renewal on the health poll. The poll waits for it, and a renewal
 * that cannot reach the API changes nothing, so it is kept short. */
export const RENEW_BUDGET_MS = 5_000;
/** The status check before an automatic reconnect, when this device's
 * slot was never confirmed (docs/device-slots.md, obligation 9). */
export const STANDING_CHECK_BUDGET_MS = 4_000;
/** Release on Disconnect: fire and forget, never delaying the teardown. */
export const RELEASE_BUDGET_MS = 1_500;

/** The renewal interval when a grant does not say. The contract's value. */
export const DEFAULT_RENEW_EVERY_SEC = 60;
/** How long the server keeps a slot nobody renews, when a grant does not
 * say. The contract's value. */
export const DEFAULT_STALE_AFTER_SEC = 90;

/** A device as another device sees it. `label` may be null ("another
 * device"); the handle is what a takeover names. */
export interface SlotDevice {
  handle: string | null;
  label: string | null;
  platform: string | null;
}

/** One of the devices using the plan's slots, from a 409. */
export interface SlotHolder extends SlotDevice {
  handle: string;
  /** ISO time it got its slot. Null if the server's value was unusable. */
  since: string | null;
  /** ISO time it last renewed or carried traffic. */
  lastSeen: string | null;
}

/** A 409 `DEVICE_LIMIT`: every slot is in use. */
export interface DeviceLimitRefusal {
  limit: number | null;
  holders: SlotHolder[];
}

export interface SlotGrant {
  /** False when nothing was recorded: an unlimited plan (`limit` null),
   * or a plan with a limit whose slot was not counted -- a token from
   * before sessions, or slots switched off on the server. */
  enforced: boolean;
  limit: number | null;
  handle: string | null;
  renewEverySec: number;
  /** After this long with no renewal and no traffic, the server gives
   * the slot to whichever device asks next. */
  staleAfterSec: number;
}

/** No verdict. Dial anyway, or keep the tunnel.
 *
 * `retryable` says whether asking again could produce one: a timeout or
 * a 5xx could, a 400 or a 404 will not.
 *
 * `noAnswer` says whether anything came back at all. True only when
 * nothing did -- no answer within the budget, or the request failed in
 * transport everywhere it was sent -- and only then may the screen say
 * Neoxify could not be reached. A 5xx, a 404, a 429, a 200 this app
 * cannot read: each is an answer, and what is true then is that Neoxify
 * did not confirm anything, not that it was out of reach. */
export interface NoVerdict {
  kind: "unanswered";
  reason: string;
  retryable: boolean;
  noAnswer: boolean;
}

export type ClaimOutcome =
  | { kind: "granted"; grant: SlotGrant }
  | { kind: "refused"; refusal: DeviceLimitRefusal }
  /** 409 `SUBSCRIPTION_INACTIVE`. */
  | { kind: "inactive"; subscriptionStatus: string | null }
  /** 429 `TAKEOVER_LIMIT`: only a claim with `takeover` gets this. */
  | { kind: "takeoverLimited"; retryAfterSec: number | null }
  /** The session has ended; `apiRequest` has already told the app. */
  | { kind: "signedOut" }
  | NoVerdict;

export type RenewOutcome =
  | { kind: "held"; grant: SlotGrant }
  /** Another device has the slot: it took it over at `at`, or got it
   * after this device went quiet. */
  | { kind: "displaced"; by: SlotDevice | null; at: string | null }
  | { kind: "inactive"; subscriptionStatus: string | null }
  | { kind: "signedOut" }
  | NoVerdict;

type Fields = Record<string, unknown>;

function fieldsOf(value: unknown): Fields | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const positiveInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

/** An ISO time the screen can format, or null. */
function time(value: unknown): string | null {
  const raw = text(value);
  return raw !== null && Number.isFinite(Date.parse(raw)) ? raw : null;
}

function deviceFrom(value: unknown): SlotDevice | null {
  const f = fieldsOf(value);
  if (!f) return null;
  return { handle: text(f.handle), label: text(f.label), platform: text(f.platform) };
}

/** The renewal interval, from the grant, kept within sense. The server
 * says 60; a value of zero would turn the poll into a request storm and
 * one of an hour would let the slot lapse, so either is bounded. */
function renewEvery(value: unknown): number {
  const sec = positiveInt(value) ?? DEFAULT_RENEW_EVERY_SEC;
  return Math.min(300, Math.max(15, sec));
}

/** The same for how long an unrenewed slot lasts. Bounded below so a
 * stray value cannot make every slot look lapsed between two polls. */
function staleAfter(value: unknown): number {
  const sec = positiveInt(value) ?? DEFAULT_STALE_AFTER_SEC;
  return Math.min(600, Math.max(30, sec));
}

function grantFrom(body: Fields): SlotGrant {
  return {
    enforced: body.enforced === true,
    limit: positiveInt(body.limit),
    handle: text(body.handle),
    renewEverySec: renewEvery(body.renewEverySec),
    staleAfterSec: staleAfter(body.staleAfterSec),
  };
}

/** The holders of a 409, read defensively: an entry without a handle
 * cannot be taken over and is dropped; anything else missing reads as
 * unknown rather than failing the whole refusal. */
export function refusalFrom(body: unknown): DeviceLimitRefusal {
  const f = fieldsOf(body);
  const raw = Array.isArray(f?.holders) ? (f.holders as unknown[]) : [];
  const holders: SlotHolder[] = [];
  for (const entry of raw) {
    const h = fieldsOf(entry);
    const handle = text(h?.handle);
    if (!h || handle === null) continue;
    holders.push({
      handle,
      label: text(h.label),
      platform: text(h.platform),
      since: time(h.since),
      lastSeen: time(h.lastSeen),
    });
  }
  return { limit: positiveInt(f?.limit), holders };
}

/** A failed claim or renewal that is no verdict, and whether asking
 * again could produce one: a timeout, a 5xx or a 429 could; a 400 or a
 * 404 will not. */
function unanswered(failure: RequestFailure): NoVerdict {
  // Never arrived, or arrived somewhere that could not answer: the next
  // attempt may well get through. A 429 without the slot code is the
  // request limit or a CDN, not a verdict on this device.
  const { status } = failure;
  const retryable = status === undefined || status >= 500 || status === 429 || status === 408;
  // Only a transport failure everywhere is known to have gone
  // unanswered. A failure with no status is not enough: a 401 whose
  // refresh could not complete has none, and was answered.
  return { kind: "unanswered", reason: failure.error, retryable, noAnswer: failure.noResponse === true };
}

/** A request that ran out of its budget: nothing came back in time. */
function timedOut(error: string): NoVerdict {
  return { kind: "unanswered", reason: error, retryable: true, noAnswer: true };
}

/** What a failed claim means.
 *
 * Exactly three answers are a verdict (docs/device-slots.md, obligation
 * 2): 409 `DEVICE_LIMIT`, 409 `SUBSCRIPTION_INACTIVE` and 429
 * `TAKEOVER_LIMIT`. A sign-out is the session ending, as on any call.
 * Everything else -- a 409 or a 429 without one of those codes, a 404,
 * a 5xx, no answer -- is no verdict, and the app dials anyway. */
function claimFailure(failure: RequestFailure): Exclude<ClaimOutcome, { kind: "granted" }> {
  if (failure.sessionExpired) return { kind: "signedOut" };
  const { status, code } = failure;
  if (status === 409 && code === "DEVICE_LIMIT") return { kind: "refused", refusal: refusalFrom(failure.body) };
  if (status === 409 && code === "SUBSCRIPTION_INACTIVE") {
    return { kind: "inactive", subscriptionStatus: text(fieldsOf(failure.body)?.subscriptionStatus) };
  }
  if (status === 429 && code === "TAKEOVER_LIMIT") {
    const retryAfter = fieldsOf(failure.body)?.retryAfterSec;
    return {
      kind: "takeoverLimited",
      retryAfterSec: typeof retryAfter === "number" && retryAfter > 0 ? Math.ceil(retryAfter) : null,
    };
  }
  return unanswered(failure);
}

/** Runs one request with a deadline of its own.
 *
 * Two mechanisms, because either alone leaks. The signal stops the
 * request itself, so a blackholed endpoint is not walked on after the
 * deadline. The race stops the *wait*, which the signal cannot do on its
 * own: a 401 sends `apiRequest` off to refresh the token first, and that
 * refresh does not carry this signal.
 */
async function withinBudget<T>(
  budgetMs: number,
  run: (signal: AbortSignal) => Promise<ApiResult<T>>,
): Promise<ApiResult<T> | { ok: false; timedOut: true; error: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ ok: false; timedOut: true; error: string }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, timedOut: true, error: `no answer within ${budgetMs} ms` });
    }, budgetMs);
  });
  try {
    return await Promise.race([
      run(controller.signal).catch(
        (err: unknown): ApiResult<T> => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ClaimRequest {
  subscriptionId: string;
  /** The credential about to be dialled (`GET /customer/protocol-users`
   * `id`). When it is a shared one, its traffic then counts as this
   * device's. */
  protocolUserId?: string | null;
  /** Handles from a refusal, after the customer chose "Use on this device
   * instead". */
  takeover?: string[];
}

/** Asks for a slot before dialling. Never rejects. */
export async function claimSlot(request: ClaimRequest, budgetMs = CLAIM_BUDGET_MS): Promise<ClaimOutcome> {
  // Only the fields the contract names: the API rejects unknown ones.
  const body: Fields = { subscriptionId: request.subscriptionId };
  if (request.protocolUserId) body.protocolUserId = request.protocolUserId;
  if (request.takeover && request.takeover.length > 0) {
    // The server's own bounds: at most 16 handles of at most 64
    // characters. Past those the whole claim would be a 400.
    body.takeover = request.takeover.filter((h) => h.length > 0 && h.length <= 64).slice(0, 16);
  }

  const result = await withinBudget(budgetMs, (signal) =>
    apiRequest<unknown>("/customer/vpn/claim", {
      method: "POST",
      body: JSON.stringify(body),
      headers: deviceHeaders(),
      signal,
    }),
  );

  if (result.ok) {
    const f = fieldsOf(result.data);
    if (!f || f.granted !== true) {
      return { kind: "unanswered", reason: "the claim's answer was not a grant", retryable: false, noAnswer: false };
    }
    return { kind: "granted", grant: grantFrom(f) };
  }
  if ("timedOut" in result) return timedOut(result.error);
  return claimFailure(result);
}

/** Keeps the slot, every `renewEverySec` while connected. Never rejects. */
export async function renewSlot(subscriptionId: string, budgetMs = RENEW_BUDGET_MS): Promise<RenewOutcome> {
  const result = await withinBudget(budgetMs, (signal) =>
    apiRequest<unknown>("/customer/vpn/renew", {
      method: "POST",
      body: JSON.stringify({ subscriptionId }),
      signal,
    }),
  );

  if (result.ok) {
    const f = fieldsOf(result.data);
    switch (f?.status) {
      case "held":
        return { kind: "held", grant: grantFrom(f) };
      case "displaced":
        return { kind: "displaced", by: deviceFrom(f.by), at: time(f.at) };
      case "inactive":
        return { kind: "inactive", subscriptionStatus: text(f.subscriptionStatus) };
      default:
        return {
          kind: "unanswered",
          reason: "the renewal's answer had no status this app knows",
          retryable: false,
          noAnswer: false,
        };
    }
  }
  if ("timedOut" in result) return timedOut(result.error);

  // A renewal's verdicts come in a 200's `status`, never as a refusal.
  // Anything else -- a 5xx, a 429, a 404, even a 409 naming a code --
  // changes nothing (obligation 6): keep the tunnel and ask again at the
  // next interval. Only a sign-out ends the session, as on any call.
  if (result.sessionExpired) return { kind: "signedOut" };
  return unanswered(result);
}

export interface ReleaseRequest {
  subscriptionId: string;
  /** The `handle` of the grant being given back: the latest claim's, or
   * the renewal's that re-granted the slot.
   *
   * Required, and that is the point of it. A release is fire and forget,
   * and the request can still be walking the API's mirrors seconds after
   * the customer pressed Connect again; the claim that Connect made gave
   * the slot a new handle, so a late release naming the old one frees
   * nothing. One naming no handle frees whatever this device holds --
   * the new connect's slot included -- so this app never sends one. */
  handle: string;
}

/** Gives one grant back.
 *
 * Fire and forget: resolves within `budgetMs` whatever happens and never
 * rejects, and nothing should wait for it before tearing down. A release
 * that does not arrive costs the slot staying taken until it goes stale
 * (90 s), which "Use on this device instead" covers on the other device.
 */
export async function releaseSlot(request: ReleaseRequest, budgetMs = RELEASE_BUDGET_MS): Promise<void> {
  try {
    await withinBudget(budgetMs, (signal) =>
      apiRequest<void>("/customer/vpn/release", {
        method: "POST",
        // Only the fields the contract names: the API rejects unknown ones.
        body: JSON.stringify({ subscriptionId: request.subscriptionId, handle: request.handle }),
        signal,
      }),
    );
  } catch {
    // Nothing on screen depends on this having worked.
  }
}

/** The attempt report for a connect that was refused before dialling.
 *
 * A refusal is the account's limit, not the network's: it reaches the
 * server as REJECTED with no ladder, so it records no dial -- nothing in
 * the per-ISP evidence, no route marked as failing (the server counts
 * rungs only). The reason is the server's code, so a refusal can be told
 * from a wrong password in the same column. */
export function refusalReport(code: "DEVICE_LIMIT" | "SUBSCRIPTION_INACTIVE" | "TAKEOVER_LIMIT"): AttemptReport {
  return {
    kind: "CONNECT",
    outcome: outcomeFromError(code === "SUBSCRIPTION_INACTIVE" ? "subscriptionInactive" : "concurrentLimit"),
    reason: code,
  };
}
