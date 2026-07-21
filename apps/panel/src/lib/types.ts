// Mirrors the backend's Prisma-derived response shapes (apps/backend).
// Kept hand-written rather than generated for now -- see the shared
// api-types package in the monorepo plan for a future OpenAPI-generated
// version once the API surface stabilizes.

export type AdminRole = "SUPERADMIN" | "SUPPORT" | "BILLING";

export interface AdminUser {
  id: string;
  email: string;
  role: AdminRole;
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
