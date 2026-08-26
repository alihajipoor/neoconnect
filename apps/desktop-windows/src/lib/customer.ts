import { apiRequest } from "./api";
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
 * nothing at all. */
const GAMING_PROFILE_TTL_MS = 30_000;
let gamingProfileCache: { at: number; value: ApiResult<GamingProfileResponse> } | null = null;
let gamingProfileInFlight: Promise<ApiResult<GamingProfileResponse>> | null = null;

export function getGamingProfile(): Promise<ApiResult<GamingProfileResponse>> {
  const fresh = gamingProfileCache && Date.now() - gamingProfileCache.at < GAMING_PROFILE_TTL_MS;
  if (fresh && gamingProfileCache) return Promise.resolve(gamingProfileCache.value);
  if (gamingProfileInFlight) return gamingProfileInFlight;

  gamingProfileInFlight = apiRequest<GamingProfileResponse>("/customer/gaming-profile")
    .then((result) => {
      if (result.ok) gamingProfileCache = { at: Date.now(), value: result };
      return result;
    })
    .finally(() => {
      gamingProfileInFlight = null;
    });
  return gamingProfileInFlight;
}

/** Throw the cached catalogue away.
 *
 * For the cases where the answer can legitimately change out from under the
 * TTL -- a plan redeemed, a different customer signing in -- so that
 * entitlement is never shown from a previous session. */
export function clearGamingProfileCache(): void {
  gamingProfileCache = null;
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
