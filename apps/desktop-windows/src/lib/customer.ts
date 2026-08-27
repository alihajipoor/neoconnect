import { apiRequest, apiRequestRevalidated } from "./api";
import type { ApiResult } from "./api";
import type {
  AppLinks,
  Customer,
  PaymentProvider,
  PaymentStart,
  ProtocolUser,
  ReferralOverview,
  RouteOption,
  Subscription,
  SubscriptionPlan,
  SupportOverview,
  SupportThread,
} from "./types";

export const getMe = () => apiRequest<Customer>("/customer/me");
export const getSubscriptions = () => apiRequest<Subscription[]>("/customer/subscriptions");
export const getProtocolUsers = () => apiRequest<ProtocolUser[]>("/customer/protocol-users");
export const getAppLinks = () => apiRequest<AppLinks>("/customer/links");

export const getPlans = () => apiRequest<SubscriptionPlan[]>("/customer/plans");

/** What a voucher code would grant, without spending it.
 *
 * Separate from redeeming so the customer can see the plan and confirm.
 * A code that converts on the last keystroke is not something anyone
 * should have to be careful around. */
export const previewVoucher = (code: string) =>
  apiRequest<{ code: string; plan: SubscriptionPlan; expiresAt: string | null }>(
    "/customer/vouchers/preview",
    { method: "POST", body: JSON.stringify({ code }) },
  );

export const redeemVoucher = (code: string) =>
  apiRequest<{ subscription: Subscription }>("/customer/vouchers/redeem", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
export const getReferrals = () => apiRequest<ReferralOverview>("/customer/referrals");

export const getAvailableRoutes = (subscriptionId: string) =>
  apiRequest<RouteOption[]>(`/customer/subscriptions/${subscriptionId}/routes`);

export const switchRoute = (subscriptionId: string, routeId: string) =>
  apiRequest<ProtocolUser>(`/customer/subscriptions/${subscriptionId}/route`, {
    method: "POST",
    body: JSON.stringify({ routeId }),
  });

/** Creates the subscription row only. It is not usable until a payment
 * clears -- credentials aren't provisioned until the provider's webhook
 * confirms, so this on its own grants nothing. */
export const createSubscription = (planId: string) =>
  apiRequest<Subscription>("/customer/subscriptions", {
    method: "POST",
    body: JSON.stringify({ planId }),
  });

export const startPayment = (subscriptionId: string, provider: PaymentProvider) =>
  apiRequest<PaymentStart>("/customer/billing/payments", {
    method: "POST",
    body: JSON.stringify({ subscriptionId, provider }),
  });

/** One game the operator has curated, with the exact set of names that
 * would be redirected if it were chosen.
 *
 * The hostnames come from the server and are never guessed here: a
 * client-side guess at what belongs to a game is how you end up
 * redirecting something that should have been left alone, and the
 * customer has no way to tell that happened. */
export interface GameProfileSummary {
  slug: string;
  displayName: string;
  iconKey: string | null;
  publisher: string | null;
  hostnames: string[];
  excludeHostnames: string[];
  canaryHostname: string | null;
  /** Executable names covering the game AND everything it launches
   * beside itself -- launcher, patcher, anti-cheat.
   *
   * This is the half of gaming mode that needs no node: these go into
   * the split tunnel, which already exists and already works. Optional
   * on the wire because a client can be newer than its server, and a
   * missing list must read as "this server has nothing to offer" rather
   * than throw. */
  processNames?: string[];
  /** Publisher address space, usable only when `prefixComplete` is
   * true. See that field. */
  destinationCidrs?: string[];
  /** Whether `destinationCidrs` covers the publisher's whole announced
   * space.
   *
   * Routing a game by a PARTIAL prefix list is worse than not routing it
   * at all: a game that holds two connections at once (WoW's Home and
   * World) would get one address for each, and one account showing two
   * source addresses at the same instant is the account-sharing
   * signature. So a false here means destination routing is refused, not
   * approximated. */
  prefixComplete?: boolean;
}

/** What this customer may use gaming mode for, and on which server.
 *
 * `unavailableReason` is the server's own answer and the client states
 * it verbatim. There is no branch here that invents one: "not available
 * on your server yet" is a different fact from "your plan does not
 * include it", and guessing between them is the kind of small lie this
 * app is built to refuse. */
export interface GamingProfileResponse {
  version: 1;
  entitled: boolean;
  unavailableReason: "noSubscription" | "notEntitled" | "noResolver" | null;
  resolver: { dohUrl: string; proxyIp: string; proxyPort: number; nodeRegion: string } | null;
  games: GameProfileSummary[];
}

/** Cached because this payload got big and three components want it.
 *
 * The catalogue is now roughly 1,500 games and about 370 KiB of JSON.
 * `CustomModeCard` and `GamingModeCard` are both mounted on the Settings
 * screen and each fetch on mount, and `GamingStatusPanel` fetches again on
 * the Dashboard -- so without this, opening Settings pulled the whole
 * catalogue twice, back to back, on a connection that in Iran is often
 * throttled to under 1 Mbps. That is a second of dead UI bought for
 * nothing.
 *
 * Deliberately small and dumb rather than a query library: a timestamp, the
 * last good response, and the in-flight promise so two components mounting
 * in the same tick share one request instead of racing.
 *
 * Failures are NOT cached. `loadProfile` doubles as the "Try again" handler
 * behind a load failure, and a cached error would make that button do
 * nothing at all.
 *
 * Past the TTL the entry is not thrown away -- it is *revalidated*. The
 * server mints an ETag over the catalogue fingerprint plus this
 * customer's entitlement and resolver, so offering it back turns an
 * unchanged answer into a 304 with no body: 374 KB becomes a round trip.
 * The body is kept alongside the tag because a 304 carries nothing, and
 * a validator with no body to pair it with is worthless.
 *
 * Process memory only, deliberately -- never a file, never the Tauri
 * store. Both halves are per-customer entitlement state, and
 * `clearGamingProfileCache()` has no caller today, so anything persisted
 * here would outlive a sign-out and be offered on behalf of whoever
 * signs in next. */
const GAMING_PROFILE_TTL_MS = 30_000;
/** The body, the validator that stands for it, and when it was last
 * confirmed current. The three only make sense together, so they live in
 * one object -- which is also what makes `clearGamingProfileCache()`
 * dropping the tag along with the body unmissable rather than a second
 * line somebody can forget. */
type GamingProfileEntry = {
  at: number;
  value: { ok: true; data: GamingProfileResponse };
  etag: string | null;
};
let gamingProfileCache: GamingProfileEntry | null = null;
let gamingProfileInFlight: Promise<ApiResult<GamingProfileResponse>> | null = null;
/** Bumped by every clear, so a request that was already on the wire when
 * the session ended cannot write its answer into the cache afterwards.
 *
 * Nulling the cache is not enough on its own. A fetch issued with the
 * previous customer's bearer token resolves *after* the clear and then
 * assigns `gamingProfileCache` unconditionally -- so the entitlement the
 * clear just removed reappears, now on behalf of whoever signed in next.
 * The 304 branch already guarded against this by identity-checking
 * `held`; the 200 branch had nothing, because on a full body there is no
 * `held` to compare. A counter covers both without either branch having
 * to reason about the other. */
let gamingProfileGeneration = 0;

/** `held` is the entry `validator` was taken from, so a 304 can be
 * matched against the body it actually stands for. */
async function loadGamingProfile(
  validator: string | null,
  held: GamingProfileEntry | null,
): Promise<ApiResult<GamingProfileResponse>> {
  // Read before awaiting, compared after: the window this closes is
  // exactly the duration of that await.
  const generation = gamingProfileGeneration;
  const result = await apiRequestRevalidated<GamingProfileResponse>("/customer/gaming-profile", validator);
  if (!result.ok) return result;

  if (result.notModified) {
    // The cache must still be the entry the tag was minted against. If
    // it was cleared or replaced while this was in flight -- a different
    // customer signing in is exactly that case -- there is no body this
    // 304 speaks for, and serving `held` anyway would show one
    // customer's entitlement to another. Ask again unconditionally
    // instead: belt and braces, and a re-download is the honest answer
    // where an error would only give the customer a button to press.
    if (!held || gamingProfileCache !== held) return loadGamingProfile(null, null);

    // Confirmed current, so the TTL restarts from now. That is the whole
    // point: the next 30 s are served from memory without the catalogue
    // crossing the wire again.
    gamingProfileCache = { at: Date.now(), value: held.value, etag: result.etag ?? held.etag };
    return held.value;
  }

  const value = { ok: true as const, data: result.data };
  // The caller that asked still gets its answer; the cache does not.
  // This request was issued under the previous customer's token, and
  // writing it here is precisely how their entitlement would be served
  // to whoever signed in next.
  if (generation === gamingProfileGeneration) {
    gamingProfileCache = { at: Date.now(), value, etag: result.etag };
  }
  return value;
}

export function getGamingProfile(): Promise<ApiResult<GamingProfileResponse>> {
  const held = gamingProfileCache;
  if (held && Date.now() - held.at < GAMING_PROFILE_TTL_MS) return Promise.resolve(held.value);
  if (gamingProfileInFlight) return gamingProfileInFlight;

  // `mine` rather than a bare null on settle: a clear can drop the
  // reference and a new request can take its place while this one is
  // still open, and an unconditional null would throw *that* request's
  // sharing away and make the next caller open a third.
  const mine: Promise<ApiResult<GamingProfileResponse>> = loadGamingProfile(
    held?.etag ?? null,
    held,
  ).finally(() => {
    if (gamingProfileInFlight === mine) gamingProfileInFlight = null;
  });
  gamingProfileInFlight = mine;
  return mine;
}

/** Throw the cached catalogue away.
 *
 * For the cases where the answer can legitimately change out from under the
 * TTL -- a plan redeemed, a different customer signing in -- so that
 * entitlement is never shown from a previous session. The ETag goes with
 * it: the tag mixes in the customer id, and offering a previous
 * customer's validator would ask the server a question about somebody
 * else.
 *
 * The in-flight promise goes too, and that one is not housekeeping. It
 * is shared: `getGamingProfile` hands the *same* promise to every caller
 * while a request is open. Leaving it in place means the first thing the
 * next customer's screen does is await the previous customer's request
 * and render its answer -- no cache read involved, so nulling the cache
 * alone would not have stopped it. Dropping the reference does not
 * cancel the request; the generation counter is what stops its result
 * from being kept. */
export function clearGamingProfileCache(): void {
  gamingProfileCache = null;
  gamingProfileInFlight = null;
  gamingProfileGeneration += 1;
}

/** Whether support is open, plus this customer's own conversations. */
export const getSupportOverview = () => apiRequest<SupportOverview>("/customer/support");

export const openSupportTicket = (subject: string, body: string) =>
  apiRequest<SupportThread>("/customer/support/tickets", {
    method: "POST",
    body: JSON.stringify({ subject, body }),
  });

/** Fetching a thread also marks it read -- opening it is reading it. */
export const getSupportThread = (id: string) =>
  apiRequest<SupportThread>(`/customer/support/tickets/${id}`);

export const replyToSupportTicket = (id: string, body: string) =>
  apiRequest<SupportThread>(`/customer/support/tickets/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
