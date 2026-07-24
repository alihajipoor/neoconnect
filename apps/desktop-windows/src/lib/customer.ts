import { apiRequest } from "./api";
import type { Customer, ProtocolUser, RouteOption, Subscription, SubscriptionPlan } from "./types";

export const getMe = () => apiRequest<Customer>("/customer/me");
export const getSubscriptions = () => apiRequest<Subscription[]>("/customer/subscriptions");
export const getProtocolUsers = () => apiRequest<ProtocolUser[]>("/customer/protocol-users");
export const getPlans = () => apiRequest<SubscriptionPlan[]>("/customer/plans");

export const getAvailableRoutes = (subscriptionId: string) =>
  apiRequest<RouteOption[]>(`/customer/subscriptions/${subscriptionId}/routes`);

export const switchRoute = (subscriptionId: string, routeId: string) =>
  apiRequest<ProtocolUser>(`/customer/subscriptions/${subscriptionId}/route`, {
    method: "POST",
    body: JSON.stringify({ routeId }),
  });
