import { apiRequest } from "./api";
import type { Customer, ProtocolUser, Subscription, SubscriptionPlan } from "./types";

export const getMe = () => apiRequest<Customer>("/customer/me");
export const getSubscriptions = () => apiRequest<Subscription[]>("/customer/subscriptions");
export const getProtocolUsers = () => apiRequest<ProtocolUser[]>("/customer/protocol-users");
export const getPlans = () => apiRequest<SubscriptionPlan[]>("/customer/plans");
