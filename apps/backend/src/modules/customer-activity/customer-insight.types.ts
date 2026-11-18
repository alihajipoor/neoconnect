import type { AttemptRow, TrafficRow } from "./customer-activity.service";
import type { ApiTrace } from "./api-trace";
import type { FailureCode, ReportCategory } from "./insight-classify";
import type { UsageSession } from "./usage-sessions";

/** The response shapes of GET /customers/:id/insight, /attempts, /usage
 * and /history. Mirrored in apps/panel/src/lib/types.ts, which is the
 * panel's contract: change both together. Bytes are decimal strings and
 * times ISO strings throughout. */

export interface InsightNetworkRef {
  asn: number;
  name: string | null;
}

export interface InsightAccount {
  createdAt: string;
  emailVerifiedAt: string | null;
  status: string;
  locale: string;
  signupChannel: string | null;
  identities: { provider: string; createdAt: string; lastUsedAt: string }[];
  referredBy: { customerId: string; email: string } | null;
  referralsMade: number;
}

export interface InsightApp {
  platform: string;
  appVersion: string;
  lastSeenAt: string;
  /** The newest release this server already knows for the platform, or
   * null when it has no cached answer (and always for iOS). */
  latestVersion: string | null;
  behind: boolean | null;
}

export interface InsightConnect {
  /** Reports that tried to bring a tunnel up: connects, and passes of an
   * automatic reconnect. Background API reports are not attempts. */
  tried: number;
  succeeded: number;
  lastSuccess: {
    at: string;
    server: string | null;
    protocol: string | null;
    network: InsightNetworkRef | null;
    platform: string;
    appVersion: string;
  } | null;
  lastFailure: {
    at: string;
    outcome: string;
    reason: string | null;
    network: InsightNetworkRef | null;
    platform: string;
    appVersion: string;
  } | null;
  byOutcome: { outcome: string; count: number }[];
}

export interface InsightNetworkOthers {
  /** Other signed-in customers with a connection attempt on this network
   * in the last `hours` hours. */
  customers: number;
  /** How many of them connected at least once in that time. */
  connected: number;
  hours: number;
}

export interface InsightNetwork {
  /** Null groups the reports that carried no network. */
  asn: number | null;
  name: string | null;
  country: string | null;
  tried: number;
  succeeded: number;
  /** Background reports from this network that could not reach the API. */
  apiUnreachable: number;
  lastAt: string | null;
  lastSuccessAt: string | null;
  /** Null when fewer than 3 other customers tried here: too few to say
   * anything. Always null for the unknown network. */
  others: InsightNetworkOthers | null;
}

export interface InsightRoute {
  server: string | null;
  protocol: string | null;
  dialled: number;
  connected: number;
  carried: number;
  notDialled: number;
  medianDownKbps: number | null;
  medianUpKbps: number | null;
  lastResult: string;
  lastAt: string;
}

export interface InsightFailure {
  code: FailureCode;
  label: string;
  count: number;
  lastAt: string;
  /** One real text of this kind, addresses replaced by "<address>". */
  example: string;
}

export interface InsightSessions {
  count: number;
  totalSeconds: number;
  longestSeconds: number;
  lastAt: string | null;
}

export interface InsightCredentials {
  subscriptionId: string;
  planName: string;
  status: string;
  startAt: string;
  expireAt: string;
  /** Null for an unlimited plan. */
  dataCapBytes: string | null;
  dataUsedBytes: string;
  total: number;
  active: number;
  notProvisioned: number;
  held: number;
  perDevice: number;
  byProtocol: { protocol: string; count: number }[];
}

export interface InsightVoucherRedemption {
  redeemedAt: string;
  customerId: string;
  sameAccount: boolean;
  subscriptionId: string | null;
}

export interface InsightVoucher {
  voucherId: string;
  planName: string;
  issuedAt: string;
  issuedByEmail: string | null;
  /** Whether it was issued for this customer's email address. */
  issuedToThisEmail: boolean;
  maxRedemptions: number | null;
  redeemedCount: number;
  redemptions: InsightVoucherRedemption[];
}

export type FindingSeverity = "problem" | "warning" | "info";

export interface InsightFinding {
  severity: FindingSeverity;
  code: string;
  title: string;
  detail: string;
}

export interface CustomerInsight {
  windowDays: number;
  generatedAt: string;
  account: InsightAccount;
  apps: InsightApp[];
  reports: Record<ReportCategory, number>;
  connect: InsightConnect;
  networks: InsightNetwork[];
  routes: InsightRoute[];
  failures: InsightFailure[];
  sessions: InsightSessions;
  credentials: InsightCredentials[];
  vouchers: InsightVoucher[];
  findings: InsightFinding[];
}

/** One row of GET /customers/:id/attempts: the activity page's attempt,
 * plus what the insight derives from it. */
export interface CustomerAttemptDetail extends AttemptRow {
  receivedAt: string;
  occurredAt: string | null;
  category: ReportCategory;
  failureCode: FailureCode | null;
  apiEndpoint: string | null;
  apiTrace: ApiTrace | null;
}

export interface UsageHour {
  hour: string;
  nodeName: string;
  protocol: string;
  bytesUp: string;
  bytesDown: string;
}

export interface CustomerUsage {
  hours: UsageHour[];
  sessions: UsageSession[];
  /** True when the window held more upload periods than are read for
   * sessions, so the oldest sessions in it are missing. */
  sessionsCapped: boolean;
  days: TrafficRow[];
}

export type HistoryEventType =
  | "ACCOUNT_CREATED"
  | "EMAIL_VERIFIED"
  | "IDENTITY_LINKED"
  | "DEVICE_SIGNED_IN"
  | "DEVICE_SIGNED_OUT"
  | "SUBSCRIPTION_STARTED"
  | "SUBSCRIPTION_ENDED"
  | "CODE_REDEEMED"
  | "PAYMENT"
  | "SUPPORT_TICKET"
  | "FIRST_CONNECT"
  | "STAFF_ACTION";

export interface CustomerHistoryEvent {
  at: string;
  type: HistoryEventType;
  title: string;
  detail: string | null;
  actor: string | null;
  /** A panel path to open, where there is one. */
  link: string | null;
}
