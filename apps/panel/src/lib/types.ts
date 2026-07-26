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
  createdAt: string;
  updatedAt: string;
}

export type Protocol = "XRAY_VLESS_REALITY" | "XRAY_VMESS" | "XRAY_TROJAN" | "WIREGUARD" | "OPENVPN";

export const ALL_PROTOCOLS: Protocol[] = [
  "XRAY_VLESS_REALITY",
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

export type SubscriptionStatus = "ACTIVE" | "SUSPENDED" | "EXPIRED" | "CANCELLED";

export interface SubscriptionPlan {
  id: string;
  name: string;
  dataCapBytes: string;
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
