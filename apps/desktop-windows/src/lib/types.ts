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
  /** Null means unlimited traffic. */
  dataCapBytes: string | null;
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
  | "SHADOWSOCKS"
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
  /** How the protocol is carried, and what wraps it.
   *
   * The same Protocol member is served over plain TCP and inside a
   * WebSocket -- that is what the server's `transport` column exists to
   * express -- so a client cannot infer the stream shape from the
   * protocol alone, and guessing wrong fails the handshake.
   *
   * Optional because a node registered before these columns existed
   * reports neither, and every one of those is plain TCP. */
  transport?: "TCP" | "WS" | "GRPC";
  security?: "NONE" | "TLS" | "REALITY";
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
  /** Null means unlimited traffic. */
  dataCapBytes: string | null;
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

/** Where to find the product outside the app.
 *
 * Served by the backend rather than compiled in, so a Discord invite
 * that expires or an account that gets renamed does not need a new
 * release. Every field is nullable and the app renders only what is
 * set, so there is no way to end up with a button going nowhere. */
export interface AppLinks {
  websiteUrl: string | null;
  discordUrl: string | null;
  instagramUrl: string | null;
  telegramUrl: string | null;
}

/** Support conversations.
 *
 * Async tickets, shown as a chat. The distinction matters for what the
 * UI is allowed to promise: there is nobody watching a socket, so the
 * screen says when a reply is likely rather than implying one is
 * coming right now. */
export type SupportTicketStatus = "OPEN" | "ANSWERED" | "RESOLVED";

export interface SupportMessage {
  id: string;
  fromAdmin: boolean;
  body: string;
  createdAt: string;
}

export interface SupportTicketSummary {
  id: string;
  subject: string;
  status: SupportTicketStatus;
  lastMessageAt: string;
  createdAt: string;
  /** Computed by the backend so the app and any future client cannot
   * disagree about what counts as unread. */
  unread: boolean;
}

export interface SupportThread {
  id: string;
  subject: string;
  status: SupportTicketStatus;
  lastMessageAt: string;
  messages: SupportMessage[];
}

export interface SupportOverview {
  /** Off means no new conversations. Existing ones stay open, so the
   * app still shows the reply box inside a thread. */
  acceptingTickets: boolean;
  awayMessage: string | null;
  replyWithinHours: number | null;
  tickets: SupportTicketSummary[];
}
