import { apiRequest } from "./api";
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
