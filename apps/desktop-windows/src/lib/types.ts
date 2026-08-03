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
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// PENDING was added backend-side when self-purchase landed (a
// subscription exists before the payment clears) but never mirrored
// here, so the app had no way to express "created, not paid for" and
// treated one as a real subscription.
export type SubscriptionStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "EXPIRED" | "CANCELLED";

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

export type Protocol =
  | "XRAY_VLESS_REALITY"
  | "XRAY_VLESS_TLS"
  | "XRAY_VMESS"
  | "XRAY_TROJAN"
  | "WIREGUARD"
  | "OPENVPN";

export type PaymentProvider = "STRIPE" | "NOWPAYMENTS";

/** What starting a payment gives back.
 *
 * Cards return a hosted Checkout URL to open in the system browser --
 * card details never enter this app. Crypto returns an address and
 * amount to display. Neither tells us the payment succeeded: that's
 * confirmed by the provider's webhook, so the app watches its own
 * subscription instead of trusting anything here. */
export type PaymentStart =
  | { transactionId: string; provider: "STRIPE"; checkoutUrl: string }
  | {
      transactionId: string;
      provider: "NOWPAYMENTS";
      payAddress: string;
      payAmount: number;
      payCurrency: string;
    };

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
  /** Per-user speed caps in Mbit/s, null = uncapped. Worth showing on the
   * plan card: "how fast" is the second thing anyone asks after price. */
  maxDownloadMbps: number | null;
  maxUploadMbps: number | null;
  protocolsAllowed: Protocol[];
  isActive: boolean;
  defaultRouteId: string | null;
  createdAt: string;
  updatedAt: string;
}

// register() never returns a usable session anymore (2026-07-24 decision:
// no login without email verification, not just no VPN access) -- it
// always resolves to this shape. login() resolves to either this (account
// exists but isn't verified yet) or a real TokenPair.
export interface RequiresVerification {
  requiresVerification: true;
  email: string;
}

export type LoginResult = TokenPair | RequiresVerification;

export interface VerifyResult {
  alreadyVerified: boolean;
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
  /** Entry endpoint the client dials. Used to measure latency locally --
   * a figure measured on the backend would describe the backend's
   * network, not the customer's. Only the entry is exposed; a relay's
   * exit node stays hidden. */
  endpoint: { host: string; port: number };
  /** What the control plane knows from agent heartbeats. Distinct from
   * latency: "is it up" rather than "is it fast for me". */
  nodeStatus: "ONLINE" | "OFFLINE" | "PENDING" | "DISABLED";
}

/** What GET /customer/referrals returns.
 *
 * Friends arrive already masked -- the server never sends the real
 * addresses, so there is nothing here to leak by accident. */
export type ReferralOverview = {
  enabled: boolean;
  code: string | null;
  rules: {
    loyalFriendMonths: number;
    friendsRequired: number;
    friendMonths: number;
    rewardDays: number;
  };
  friends: {
    maskedEmail: string;
    joinedAt: string;
    activated: boolean;
    paidMonths: number;
  }[];
  rewards: { id: string; reason: string; rewardDays: number; grantedAt: string }[];
  progress: {
    monthsToNextReward: number;
    qualifyingFriends: number;
    bestFriendMonths: number;
  };
};
