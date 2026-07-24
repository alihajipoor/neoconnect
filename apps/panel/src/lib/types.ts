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

export interface SubscriptionPlan {
  id: string;
  name: string;
  dataCapBytes: string;
  durationDays: number;
  priceUsd: string;
  maxConcurrentConnections: number | null;
  protocolsAllowed: Protocol[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
