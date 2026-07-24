// Mirrors the backend's customer-facing response shapes (apps/backend).
// Kept hand-written for now, same as the panel's own lib/types.ts.

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface Customer {
  id: string;
  email: string;
  telegramId: string | null;
  referralCode: string | null;
  status: "ACTIVE" | "DISABLED";
  createdAt: string;
  updatedAt: string;
}

export type SubscriptionStatus = "ACTIVE" | "SUSPENDED" | "EXPIRED" | "CANCELLED";

export interface Subscription {
  id: string;
  customerId: string;
  planId: string;
  primaryNodeId: string | null;
  status: SubscriptionStatus;
  startAt: string;
  expireAt: string;
  dataCapBytes: string;
  dataUsedBytes: string;
  autoRenew: boolean;
  createdAt: string;
  updatedAt: string;
}

export type Protocol = "XRAY_VLESS_REALITY" | "XRAY_VMESS" | "XRAY_TROJAN" | "WIREGUARD" | "OPENVPN";

export interface ProtocolUserConnection {
  host: string;
  port: number;
  publicParams: Record<string, unknown>;
}

export interface ProtocolUser {
  id: string;
  subscriptionId: string;
  routeId: string;
  nodeId: string;
  protocolConfigId: string;
  protocol: Protocol;
  externalUserId: string;
  status: "ACTIVE" | "DISABLED";
  createdAt: string;
  updatedAt: string;
  credentials: Record<string, string>;
  connection: ProtocolUserConnection;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  dataCapBytes: string;
  durationDays: number;
  priceUsd: string;
  maxConcurrentConnections: number | null;
  protocolsAllowed: Protocol[];
  isActive: boolean;
  defaultRouteId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterResponse extends TokenPair {
  trial: { subscription: Subscription; protocolUser: ProtocolUser } | null;
}

// GET /customer/subscriptions/:id/routes -- the location picker's option
// list. Deliberately doesn't include uplinkCredentialsJson or the exit
// node's identity (see RoutesService.listAvailableForPlan) -- customers
// never need to know which server backs a relay's egress leg.
export interface RouteOption {
  id: string;
  name: string;
  protocol: Protocol;
  isRelay: boolean;
  location: { region: string; nodeName: string };
}
