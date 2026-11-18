import type {
  CustomerFailureCode,
  CustomerHistoryEventType,
  CustomerReportCategory,
  ReportDetails,
  ReportNetDetails,
  ReportTunnelDetails,
  ServiceCheckStage,
} from "@/lib/types";

/** Plain-English names for the codes the customer insight endpoints send.
 *
 * Each map is a full Record over the backend's union, so a code added
 * there without a label here fails the typecheck; insight-labels.test.ts
 * checks the same at run time. The failure labels say what the app
 * reported and never a cause it did not report -- the same rule as the
 * backend's own wording (insight-classify.ts). */

/** What a report was. */
export const CATEGORY_LABELS: Record<CustomerReportCategory, string> = {
  connect: "Connect",
  reconnect: "Automatic reconnect",
  api: "Could not reach our API",
  config: "Server settings changed",
  cancelled: "Stopped by the customer",
  session: "Stayed up",
  signin: "Sign-in",
  register: "Sign-up",
  check: "Service check",
  other: "Other",
};

/** What a failure was, from the app's own words. */
export const FAILURE_LABELS: Record<CustomerFailureCode, string> = {
  API_UNREACHABLE: "Could not reach our API",
  NOT_CARRYING: "Tunnel came up but carried no traffic",
  NO_HANDSHAKE_OR_TRAFFIC: "Handshake did not complete or the tunnel carried nothing",
  TOO_SLOW: "Tunnel worked but was too slow to keep",
  NO_RESPONSE_UDP_BLOCKED: "IKEv2 on Windows or Linux: no response from the server",
  DID_NOT_COMPLETE: "IKEv2 on Android: did not complete in time",
  SERVER_NOT_REACHED: "Timeout, refusal or failed handshake",
  NO_NETWORK: "No network connection on the device",
  SERVICE_NOT_ANSWERING: "Windows background service did not answer",
  ADAPTER_MISSING: "Tunnel network adapter missing",
  ENGINE_FAILED: "VPN engine did not start",
  PERMISSION_DENIED: "VPN permission declined or removed",
  OTHER_VPN_ACTIVE: "Another VPN held the device",
  CANCELLED_BY_CUSTOMER: "Stopped by the customer",
  SUBSCRIPTION_INACTIVE: "Subscription did not allow a connection",
  DATA_CAP_REACHED: "Plan data used up",
  DEVICE_LIMIT: "Refused by the device limit",
  WRONG_PASSWORD: "Wrong email or password",
  EMAIL_EXISTS: "Email already has an account",
  BAD_REFERRAL_CODE: "Referral code not accepted",
  CODE_NOT_ACCEPTED: "Verification, reset or recovery code not accepted",
  SESSION_REFUSED: "Session refused (signed out, revoked or disabled)",
  CUSTOM_MODE_FAILED: "Custom mode did not start or stopped",
  IKEV2_REFUSED: "IKEv2: server refused the connection or login",
  TUNNEL_DROPPED: "Phone saw its tunnel drop",
  RECONNECT_GAVE_UP: "Automatic reconnect stopped without a tunnel",
  APPLE_ACCOUNT_NEEDED: "Apple sign-in: device not signed in to an Apple Account",
  OPENVPN_DID_NOT_CONNECT: "OpenVPN did not finish connecting",
  SERVER_SETTINGS_UNUSABLE: "IKEv2: the app had no hostname for the server",
  UNKNOWN: "Not recognised (see the app's words)",
};

/** The small badge on each account history event. */
export const HISTORY_LABELS: Record<CustomerHistoryEventType, string> = {
  ACCOUNT_CREATED: "Account",
  EMAIL_VERIFIED: "Email",
  IDENTITY_LINKED: "Sign-in method",
  DEVICE_SIGNED_IN: "Device",
  DEVICE_SIGNED_OUT: "Device",
  SUBSCRIPTION_STARTED: "Subscription",
  SUBSCRIPTION_ENDED: "Subscription",
  CODE_REDEEMED: "Code",
  PAYMENT: "Payment",
  SUPPORT_TICKET: "Support",
  FIRST_CONNECT: "First connect",
  DIAGNOSTICS_SENT: "Diagnostics",
  STAFF_ACTION: "Staff",
};

/** How far a service check got, in plain words: "failed at <stage>" for
 * a failure; "ok" is the one stage that means it worked. */
export const STAGE_LABELS: Record<ServiceCheckStage, string> = {
  dns: "name lookup",
  connect: "connecting",
  tls: "secure handshake",
  http: "the reply",
  ok: "reachable",
};

export type NetType = NonNullable<ReportNetDetails["type"]>;
export type PrivateDnsMode = NonNullable<ReportNetDetails["privateDns"]>;
export type TunnelMode = NonNullable<ReportTunnelDetails["mode"]>;
export type SessionEndCause = NonNullable<ReportDetails["sessionEnd"]>["cause"];
export type CheckVia = NonNullable<ReportDetails["via"]>;

/** What the device was on, as the app said. */
export const NET_TYPE_LABELS: Record<NetType, string> = {
  wifi: "Wi-Fi",
  cellular: "Mobile data",
  ethernet: "Ethernet",
  other: "Other network",
  none: "No network",
  unknown: "Network type not known",
};

/** Android's Private DNS setting. */
export const PRIVATE_DNS_LABELS: Record<PrivateDnsMode, string> = {
  off: "Private DNS off",
  auto: "Private DNS automatic",
  host: "Private DNS set to a host",
  unknown: "Private DNS not known",
};

/** The app's tunnel mode. */
export const TUNNEL_MODE_LABELS: Record<TunnelMode, string> = {
  full: "Whole device",
  custom: "Custom (chosen apps)",
  gaming: "Gaming",
};

/** Why a session ended, as the app reported it. */
export const SESSION_END_LABELS: Record<SessionEndCause, string> = {
  disconnected: "Disconnected by the customer",
  lost: "Connection lost",
  replaced: "Replaced by a new connection",
  app_closed: "App closed",
  unknown: "Ended, cause not known",
};

/** Where a service check ran. */
export const VIA_LABELS: Record<CheckVia, string> = {
  tunnel: "through the VPN",
  direct: "outside the VPN",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage as ServiceCheckStage] ?? stage;
}

/** "reachable", or "failed at secure handshake". */
export function serviceOutcome(ok: boolean, stage: string): string {
  if (ok) return STAGE_LABELS.ok;
  if (!stage || stage === "ok") return "failed";
  return `failed at ${stageLabel(stage)}`;
}

/** A label from one of the maps above, or the value itself when the map
 * does not know it (rows outlive client versions). */
export function labelOf(map: Record<string, string>, value: string | null | undefined): string | null {
  if (!value) return null;
  return map[value] ?? value;
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as CustomerReportCategory] ?? category;
}

export function failureLabel(code: string): string {
  return FAILURE_LABELS[code as CustomerFailureCode] ?? code;
}

export function historyLabel(type: string): string {
  return HISTORY_LABELS[type as CustomerHistoryEventType] ?? type;
}
