// Mirrors the backend's Prisma-derived response shapes (apps/backend).
// Kept hand-written rather than generated for now -- see the shared
// api-types package in the monorepo plan for a future OpenAPI-generated
// version once the API surface stabilizes.

export type AdminRole = "SUPERADMIN" | "SUPPORT" | "BILLING";

export interface AdminUser {
  id: string;
  email: string;
  role: AdminRole;
  mfaEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CustomerStatus = "ACTIVE" | "DISABLED";

export interface Customer {
  id: string;
  email: string;
  telegramId: string | null;
  referralCode: string | null;
  status: CustomerStatus;
  /** Null until they click the link. Nothing VPN-related is granted
   * before this is set, so it is the first thing to check when somebody
   * reports the app refusing them. */
  emailVerifiedAt: string | null;
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

export const ALL_PROTOCOLS: Protocol[] = [
  "XRAY_VLESS_REALITY",
  "XRAY_VLESS_TLS",
  "XRAY_VMESS",
  "XRAY_TROJAN",
  "WIREGUARD",
  "OPENVPN",
];

export type NodeRole = "RELAY" | "EXIT" | "STANDALONE";
export type NodeStatus = "PENDING" | "ONLINE" | "OFFLINE" | "DISABLED";

export interface Node {
  id: string;
  name: string;
  role: NodeRole;
  region: string;
  publicIp: string;
  status: NodeStatus;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  agentPubKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProtocolConfig {
  id: string;
  nodeId: string;
  protocol: Protocol;
  listenPort: number;
  publicParamsJson: Record<string, unknown>;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Route {
  id: string;
  name: string;
  entryProtocolConfigId: string;
  exitProtocolConfigId: string | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FreeTrialSettings {
  id: string;
  enabled: boolean;
  trialPlanId: string | null;
  trialRouteId: string | null;
  updatedAt: string;
}

export interface ReferralSettings {
  id: string;
  enabled: boolean;
  rewardPlanId: string | null;
  loyalFriendMonths: number;
  friendsRequired: number;
  friendMonths: number;
  rewardDays: number;
  updatedAt: string;
}

export interface EmailSettings {
  id: string;
  enabled: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  fromAddress: string | null;
  updatedAt: string;
}

export type SubscriptionStatus =
  /** Created but not paid for. The self-serve purchase flow starts here,
   * so the panel has always been able to receive one and could not name
   * it. */
  | "PENDING"
  | "ACTIVE"
  | "SUSPENDED"
  | "EXPIRED"
  | "CANCELLED";

export interface SubscriptionPlan {
  id: string;
  name: string;
  /** Null means unlimited traffic. */
  dataCapBytes: string | null;
  durationDays: number;
  priceUsd: string;
  maxConcurrentConnections: number | null;
  /** Per-user speed caps in Mbit/s. Null = uncapped. Only enforceable on
   * WireGuard and OpenVPN -- Xray shares one connection per node. */
  maxDownloadMbps: number | null;
  maxUploadMbps: number | null;
  protocolsAllowed: Protocol[];
  isActive: boolean;
  defaultRouteId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type InvoiceStatus = "DRAFT" | "ISSUED" | "PAID" | "OVERDUE" | "VOID";

export interface InvoiceLineItem {
  description: string;
  amountUsd: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  subscriptionId: string | null;
  paymentTransactionId: string | null;
  planNameSnapshot: string;
  amountUsd: string;
  currency: string;
  status: InvoiceStatus;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
  lineItemsJson: InvoiceLineItem[];
  customer?: { email: string };
  paymentTransaction?: { provider: string } | null;
}

export interface InvoiceSummary {
  since: string;
  invoiceCount: number;
  totalUsd: string;
  byPlan: { name: string; amountUsd: string }[];
  byProvider: { provider: string; amountUsd: string }[];
}

/** Payment provider configuration. Secrets are never sent to the browser
 * -- the API returns only whether each one is set, so the form can show
 * "configured" without ever holding a live key. */
export interface PaymentSettings {
  id: string;
  stripeEnabled: boolean;
  stripePublishableKey: string | null;
  stripeSecretKeySet: boolean;
  stripeWebhookSecretSet: boolean;
  nowPaymentsEnabled: boolean;
  nowPaymentsApiKeySet: boolean;
  nowPaymentsIpnSecretSet: boolean;
  updatedAt: string;
}

/** A code that grants a plan without payment.
 *
 * The three kinds the operator asked for are two independent limits
 * that compose rather than an enum: `maxRedemptions: 1` is a one-time
 * code, `expiresAt` makes it expiring, both null makes it unlimited --
 * and a code can be both capped and expiring. */
export interface Voucher {
  id: string;
  code: string;
  planId: string;
  plan: Pick<SubscriptionPlan, "id" | "name"> & {
    durationDays?: number;
    priceUsd?: string;
  };
  maxRedemptions: number | null;
  redeemedCount: number;
  expiresAt: string | null;
  isActive: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { redemptions: number };
}

/** Links the desktop app shows in its header. All nullable: the app
 * renders only what is set, so an empty field means no button. */
export interface AppLinks {
  websiteUrl: string | null;
  discordUrl: string | null;
  instagramUrl: string | null;
  telegramUrl: string | null;
}

/** Async support conversations, rendered in the app as a chat.
 *
 * Deliberately not live chat: the operator has an away switch, so
 * promising presence would be a promise the product cannot keep. */
export type SupportTicketStatus = "OPEN" | "ANSWERED" | "RESOLVED";

export interface SupportMessage {
  id: string;
  ticketId: string;
  /** Which side wrote it. The customer only ever sees "Support", never
   * which admin answered. */
  fromAdmin: boolean;
  body: string;
  createdAt: string;
}

export interface SupportTicket {
  id: string;
  customerId: string;
  customer?: Pick<Customer, "id" | "email">;
  subject: string;
  status: SupportTicketStatus;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  messages?: SupportMessage[];
  _count?: { messages: number };
}

export interface SupportSettings {
  /** Off closes new conversations only. Threads already running stay
   * open, so nobody gets cut off mid-sentence. */
  acceptingTickets: boolean;
  awayMessage: string | null;
  replyWithinHours: number | null;
  updatedAt: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  planId: string;
  primaryNodeId: string | null;
  status: SubscriptionStatus;
  startAt: string;
  expireAt: string;
  /** Snapshot of the plan's cap at purchase. Null means unlimited. */
  dataCapBytes: string | null;
  dataUsedBytes: string;
  autoRenew: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What a client was trying to do when it reported an attempt. */
export type ClientAttemptKind = "REGISTER" | "SIGN_IN" | "CONNECT";

/** How it went, in the app's own vocabulary rather than an HTTP status.
 *
 * These are the distinctions that change what an operator does.
 * "Reached the server and it said no" and "never reached the server"
 * look identical to a customer and mean opposite things to us. */
export type ClientAttemptOutcome =
  | "SUCCESS"
  | "CONTROL_PLANE_UNREACHABLE"
  | "REJECTED"
  | "NOT_CARRYING_TRAFFIC"
  | "ENGINE_FAILED"
  | "PERMISSION_DENIED"
  | "OTHER";

/** One rung of the failover ladder, as the app recorded it. */
export interface AttemptRung {
  protocol: string;
  result: string;
}

export interface ClientAttempt {
  id: string;
  kind: ClientAttemptKind;
  outcome: ClientAttemptOutcome;
  customerId: string | null;
  customer?: Pick<Customer, "id" | "email"> | null;
  platform: string;
  appVersion: string;
  routeId: string | null;
  protocol: string | null;
  /** Null unless the client sent a ladder -- most sign-ins have none. */
  attemptsJson: AttemptRung[] | null;
  apiEndpoint: string | null;
  reason: string | null;
  ip: string | null;
  /** When the client says it happened, if that is not when it arrived.
   * A report queued while the control plane was unreachable can be hours
   * late, and those are the ones worth reading. */
  occurredAt: string | null;
  createdAt: string;
}

export interface ClientAttemptSummaryRow {
  outcome: ClientAttemptOutcome;
  count: number;
}
