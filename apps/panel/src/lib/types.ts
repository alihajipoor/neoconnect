// Mirrors the backend's Prisma-derived response shapes (apps/backend).
// Kept hand-written rather than generated for now -- see the shared
// api-types package in the monorepo plan for a future OpenAPI-generated
// version once the API surface stabilizes.

export type AdminRole = "SUPERADMIN" | "SUPPORT" | "BILLING" | "RESELLER";

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
  /** How the account came to exist; null for older accounts and ones an
   * operator made (docs/relay-last-resort.md). */
  signupChannel?: "NORMAL" | "RELAY" | "SOCIAL" | null;
  /** Set while a relay account has not confirmed its address. */
  relayUnverifiedSince?: string | null;
  recoveryCodeSetAt?: string | null;
}

export type RelayAuthMode = "OFF" | "AUTO" | "INTRANET";

/** GET /relay-auth -- the relay sign-up switch and today's numbers. */
export interface RelayAuthStatus {
  settings: {
    mode: RelayAuthMode;
    hostingAsns: number[];
    intranetDeclaredAt: string | null;
    intranetEndedAt: string | null;
    suspectedSince: string | null;
    suspicionAlertedAt: string | null;
    capsRaisedAt: string | null;
  };
  tier: "normal" | "intranet";
  caps: { global: number; perNetwork: number; hosting: number };
  hold: boolean;
  today: {
    signups: number;
    signIns: number;
    refusals: number;
    rows: { box: string; asn: number; org: string | null; signups: number; signIns: number; refusals: number }[];
  };
  detector: { ir: number; other: number; irMedian: number; otherMedian: number; holds: boolean; at: string } | null;
}

/// Mirrors the `Protocol` enum in prisma/schema.prisma. Hand-maintained,
/// which is how it drifted: SHADOWSOCKS and IKEV2 both shipped and
/// neither reached this file, so the panel could not offer them.
export type Protocol =
  | "XRAY_VLESS_REALITY"
  | "XRAY_VLESS_TLS"
  | "XRAY_VMESS"
  | "XRAY_TROJAN"
  | "SHADOWSOCKS"
  | "WIREGUARD"
  | "OPENVPN"
  | "IKEV2";

/* Every protocol, in the order the forms should list them.
 *
 * Derived from a Record rather than written out as an array, because an
 * array cannot be checked for completeness and this one silently was
 * not: SHADOWSOCKS was in the union above but missing here, and IKEV2
 * was in neither. The plan form and the protocol-config form both
 * iterate this, so two live protocols could not be granted to a plan or
 * configured on a node at all -- and with failover provisioning every
 * allowed route, customers on a panel-created plan would simply never
 * receive them.
 *
 * A Record<Protocol, true> makes the next omission a compile error
 * instead of an absence nobody notices. */
const PROTOCOL_PRESENCE: Record<Protocol, true> = {
  XRAY_VLESS_REALITY: true,
  XRAY_VLESS_TLS: true,
  XRAY_VMESS: true,
  XRAY_TROJAN: true,
  SHADOWSOCKS: true,
  WIREGUARD: true,
  OPENVPN: true,
  IKEV2: true,
};

export const ALL_PROTOCOLS = Object.keys(PROTOCOL_PRESENCE) as Protocol[];

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
  /** How the inbound is carried. Part of which Xray inbound the node
   * default resolves to: VLESS+TLS over TCP and over WebSocket are two
   * listeners sharing one port and one certificate. */
  transport?: "TCP" | "WS" | "GRPC" | null;
  /** Which Xray inbound on the node serves this config, or null for the
   * node's default for this protocol and transport. Set when a node runs
   * more than one inbound of the same protocol -- which is what lets one
   * relay serve more than one exit country. */
  inboundTag?: string | null;
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
  /** How many customer credentials are on the route -- all of which a
   * delete revokes. Absent from a backend older than this field. */
  protocolUserCount?: number;
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
  /** Whether the plan works at all -- subscriptions, including trials,
   * cannot be created on an inactive plan. */
  isActive: boolean;
  /** Whether customers are offered it. Independent of isActive. */
  isPurchasable: boolean;
  defaultRouteId: string | null;
  /** The routes this plan is served by -- relay and direct alike, and
   * the only thing that decides. EMPTY MEANS NO SERVICE: a plan with
   * nothing ticked provisions nothing. */
  allowedRoutes: { id: string }[];
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

/** What `GET /invoices` returns, which is less than an `Invoice`.
 *
 * The list route selects a projection (`INVOICE_LIST_FIELDS` in
 * `apps/backend/src/modules/invoices/invoices.service.ts`) rather than the
 * whole row: the periods, the due/paid timestamps, the line items and the
 * three foreign keys are none of them on screen in the table, and
 * `lineItemsJson` in particular is an unbounded blob per row.
 *
 * Typed separately rather than as a `Pick<Invoice, ...>` so that a field
 * added to one is not silently assumed to be on the other. Anything that
 * needs a whole invoice reads `GET /invoices/:id` and gets an `Invoice`. */
export interface InvoiceListRow {
  id: string;
  invoiceNumber: string;
  planNameSnapshot: string;
  amountUsd: string;
  currency: string;
  status: InvoiceStatus;
  issuedAt: string;
  customer: { email: string };
  paymentTransaction: { provider: string } | null;
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
  plisioEnabled: boolean;
  plisioApiKeySet: boolean;
  updatedAt: string;
}

/** One row of `GET /vouchers`, which is narrower than a whole voucher.
 *
 * The list route selects `VOUCHER_LIST_FIELDS` (in
 * `apps/backend/src/modules/vouchers/vouchers.service.ts`), and the
 * omission that matters is `recipientEmail`: it is a customer's address,
 * written only by the reseller programme, and the operator's table has
 * never had a column for it. `issuedByAdminId`, `createdAt` and
 * `updatedAt` are gone for the duller reason that no cell shows them.
 *
 * Typed separately rather than as a `Pick<Voucher, ...>` so a field added
 * to one is not silently assumed to be on the other. Anything that needs
 * a whole voucher -- create and update both return one -- gets a
 * `Voucher`. */
export interface VoucherListRow {
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
  _count?: { redemptions: number };
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

/** One row of `GET /support/tickets`, which is narrower than a whole
 * ticket.
 *
 * The list route selects `TICKET_LIST_FIELDS` (in
 * `apps/backend/src/modules/support/support.service.ts`). The omission
 * to know about is `customerLastReadAt`: that is the *customer's* unread
 * marker, read by the app to decide whether to show a dot on their side.
 * The operator's rail draws its own dot from `status` and has never
 * touched it, so nothing here loses a feature -- but if a "they have not
 * read your reply" indicator is ever wanted, it needs the field putting
 * back on the projection rather than inferring one. `customerId`,
 * `createdAt` and `updatedAt` are gone because no row shows them;
 * `lastMessageAt` is the timestamp the rail renders and sorts on.
 *
 * The open conversation still arrives whole from
 * `GET /support/tickets/:id` as a `SupportTicket`. */
export interface SupportTicketListRow {
  id: string;
  subject: string;
  status: SupportTicketStatus;
  lastMessageAt: string;
  /** Always present on a list row -- the projection selects it, and a
   * ticket cannot exist without a customer. */
  customer: Pick<Customer, "id" | "email">;
  _count: { messages: number };
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
export type ClientAttemptKind = "REGISTER" | "SIGN_IN" | "CONNECT" | "SESSION";

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
  /** The route this rung dialled, on clients new enough to say. */
  routeId?: string;
  carried?: boolean;
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
  /** Which control-plane addresses were tried, on an unreachable report
   * only. Hostnames on desktop 0.9.39-0.9.43 / mobile 0.2.22; a trace of
   * each address and how it failed on later builds. See the schema. */
  apiEndpoint: string | null;
  reason: string | null;
  ip: string | null;
  /** When the client says it happened, if that is not when it arrived.
   * A report queued while the control plane was unreachable can be hours
   * late, and those are the ones worth reading. */
  occurredAt: string | null;
  /** The network the client was on before connecting, from a signed
   * attestation. Null for older clients and unknown networks. */
  asn?: number | null;
  /** For a SESSION report: how long the tunnel had carried traffic. */
  sessionSeconds?: number | null;
  createdAt: string;
}

export interface ClientAttemptSummaryRow {
  outcome: ClientAttemptOutcome;
  count: number;
}

/** What customers see in the picker, per route, on one network. */
export interface IspTag {
  code: "worksOnYourIsp" | "failingOnYourIsp";
  customers: number;
  outOf: number;
  windowHours: number;
}

/** One route's evidence on one network, as /isp-recommendations reports it.
 * Counts are distinct signed-in customers inside the window. */
export interface IspRouteStats {
  routeId: string;
  routeName: string | null;
  nodeName: string | null;
  protocol: string | null;
  transport: string | null;
  isRelay: boolean | null;
  tried: number;
  carried: number;
  sustained: number;
  worked: number;
  tag: IspTag | null;
}

export interface IspNetwork {
  asn: number;
  org: string | null;
  routes: IspRouteStats[];
}

export interface IspRecommendationsSummary {
  windowHours: number;
  truncated: boolean;
  networks: IspNetwork[];
  dataset: { loaded: boolean; ranges: number; loadedAt: string | null };
}

// --------------------------------------------------------------- reseller

/** One plan's remaining voucher capacity for a reseller. */
export interface ResellerBalance {
  /** isActive false: the operator retired the plan, and codes for it can
   * neither be minted nor redeemed. Absent from an older backend. */
  plan: { id: string; name: string; priceUsd: string; durationDays: number; isActive?: boolean };
  balance: number;
}

/** A code a reseller issued, as their history list shows it. */
export interface ResellerVoucher {
  id: string;
  code: string;
  plan: { id: string; name: string };
  recipientEmail: string | null;
  createdAt: string;
  expiresAt: string | null;
  isActive: boolean;
  redeemedCount: number;
  redeemedAt: string | null;
  /** Computed by the backend, not the UI: the delete control and the
   * rule the server enforces must not be able to disagree. */
  canRevoke: boolean;
}

/** The operator's view of a reseller. */
export interface ResellerSummary {
  id: string;
  email: string;
  createdAt: string;
  balances: { balance: number; plan: { id: string; name: string } }[];
  vouchersIssued: number;
}

// ----------------------------------------------------------- gaming mode

/** A game the panel knows how to carry.
 *
 * What "carry" means here is narrow on purpose, and every operator-facing
 * string on the gaming page repeats it: gaming mode takes the launcher,
 * login, account, web and store surface of a game onto our network and
 * leaves the game's own connections on the customer's direct path, by
 * construction. It is not a latency product. Measured from Tehran in
 * August 2026, the direct path to Blizzard's EU game server was 72.0 ms
 * and the best node in the fleet was 72.8 ms, so there is no headroom to
 * sell and the realm addresses never pass through a resolver anyway. */
export interface GameProfile {
  id: string;
  /** URL-safe identifier the clients match on. Immutable in practice --
   * changing it orphans whatever a shipped client already caches. */
  slug: string;
  displayName: string;
  iconKey: string | null;
  publisher: string | null;
  /** Launcher, login, account, web and store hosts. Never realm/world
   * servers: the game is handed those as literal addresses inside its own
   * session, so no resolver ever sees them and listing one does nothing. */
  hostnames: string[];
  /** Hosts deliberately left on the customer's own path -- patch and CDN
   * endpoints above all, because a multi-gigabyte download pulled through
   * a node eats a metered plan's cap. */
  excludeHostnames: string[];
  /** Per-game private exit only, which is not built. */
  processNames: string[];
  /** Per-game private exit only, which is not built. */
  destinationCidrs: string[];
  /** Per-game private exit only, which is not built. */
  destinationAsn: string | null;
  /** Whether destinationCidrs is believed to cover every prefix the game
   * uses. Per-game private exit only, which is not built. */
  prefixComplete: boolean;
  /** One of `hostnames`. The client resolves it to prove the rules are
   * actually live; with none set the client can never report better than
   * "partial", because it has nothing to check. */
  canaryHostname: string | null;
  sortOrder: number;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row of `GET /gaming/profiles`, which is narrower than a
 * `GameProfile`.
 *
 * The catalogue is 1,480 games and the list route now selects
 * `PROFILE_LIST_FIELDS` (`apps/backend/src/modules/gaming/gaming.service.ts`)
 * instead of whole rows: `notes` is free text an operator wrote for
 * themselves and `processNames`/`destinationCidrs` belong to the per-game
 * private exit, which is not built and which nothing on the table shows.
 * Three list-shaped columns per row across a page is a lot of JSON for
 * fields nobody reads.
 *
 * The consequence to remember is that this type is **not enough to edit
 * from**. The form dialog re-fetches `GET /gaming/profiles/:id` for a
 * whole `GameProfile`, because pre-filling a form from a row that is
 * missing three fields and then saving it writes blanks over real values. */
export interface GameProfileListRow {
  id: string;
  slug: string;
  displayName: string;
  iconKey: string | null;
  publisher: string | null;
  hostnames: string[];
  excludeHostnames: string[];
  destinationAsn: string | null;
  prefixComplete: boolean;
  canaryHostname: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A node's DNS-over-HTTPS resolver plus the proxy it points named hosts
 * at.
 *
 * `confirmedAt` is the only field that says whether it works. Everything
 * else is what an operator typed. */
export interface GamingResolver {
  id: string;
  nodeId: string;
  node?: { id: string; name: string; region: string } | null;
  dohHost: string;
  dohPort: number;
  proxyIp: string;
  proxyPort: number;
  isEnabled: boolean;
  /** Null until the resolver has answered a probe. Null means the control
   * plane has never seen it work and will not hand it to a client. */
  confirmedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/* Feature entitlements, as a join rather than another boolean on
 * SubscriptionPlan -- the plan already carries the repo's cautionary tale
 * about one boolean doing two jobs (isActive vs isPurchasable, which cost
 * the free trial). Keep the union on one line and these two members
 * exactly as written: a drift check parses this declaration. */
export type PlanFeatureKey = "GAMING_DNS" | "GAMING_PRIVATE_EXIT";

/* Same trick as PROTOCOL_PRESENCE above, for the same reason. A Record
 * keyed by the union cannot silently miss a member, so adding a feature
 * key is a compile error here rather than a checkbox nobody notices is
 * absent from the plan grid. */
const PLAN_FEATURE_PRESENCE: Record<PlanFeatureKey, true> = {
  GAMING_DNS: true,
  GAMING_PRIVATE_EXIT: true,
};

export const ALL_PLAN_FEATURES = Object.keys(PLAN_FEATURE_PRESENCE) as PlanFeatureKey[];

export interface PlanFeatureGrant {
  planId: string;
  planName: string;
  features: PlanFeatureKey[];
}

export type ReachabilityVerdict = "REACHABLE" | "DEGRADED" | "UNREACHABLE" | "INCONCLUSIVE";

/** One vantage point's answer, as stored in the check's detail blob. */
export interface ReachabilityProbe {
  vantage: string;
  asn: string | null;
  city: string | null;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface NodeReachability {
  nodeId: string;
  name: string;
  region: string;
  /** What the node's own agent reports. Shown beside the verdict on
   * purpose: ONLINE together with UNREACHABLE is the exact condition
   * this page exists to surface, and seeing them side by side is what
   * makes it legible rather than contradictory. */
  agentStatus: string;
  verdict: ReachabilityVerdict | null;
  probesOk: number | null;
  probesAnswered: number | null;
  medianLatencyMs: number | null;
  checkedAt: string | null;
  port: number;
  detail: ReachabilityProbe[];
  /** When the current incident opened, or null when there is none. */
  openSince: string | null;
  /** False means the alert mail did not go out -- an incident nobody was
   * told about must not look like one that is merely unacknowledged. */
  alertDelivered: boolean | null;
}

/** Block watch (backend modules/block-watch). */
export type BlockWatchMode = "off" | "record" | "digest" | "notify";
export type BlockVerdict = "SUSPECT" | "LIKELY_BLOCKED";
export type BlockIncidentStatus = "OPEN" | "CLEARED" | "REPLACED" | "RETIRED";
export type BlockFamily = "client" | "traffic" | "probe";
export type BlockType = "address" | "protocol" | "tunnel";

export interface BlockNetworkFinding {
  asn: number;
  org: string | null;
  tried: number;
  failed: number;
  baseline: number | null;
  failing: boolean;
}

export interface BlockFamilyResult {
  family: BlockFamily;
  firing: boolean;
  thin: boolean;
  /** Positive evidence the server works, for what this signal measures. */
  healthy?: boolean;
  summary: string;
  networks: BlockNetworkFinding[];
}

export interface BlockEvidence {
  evaluatedAt: string;
  current: BlockVerdict | null;
  reason: string | null;
  since: Partial<Record<BlockFamily, string>>;
  families: BlockFamilyResult[];
  outage: string | null;
  blockType: BlockType | null;
  thinResidential: boolean;
  country: string;
  /** With nothing firing: shown working again (on the way to clearing),
   * or held open for want of evidence either way. */
  clearing?: string | null;
}

export interface BlockIncident {
  id: string;
  nodeId: string;
  status: BlockIncidentStatus;
  /** The strongest verdict reached; the latest is evidenceJson.current. */
  verdict: BlockVerdict;
  openedAt: string;
  lastSeenAt: string;
  likelyAt: string | null;
  closedAt: string | null;
  /** Came back soon after clearing and was opened again (not paged again). */
  reopenedAt: string | null;
  evidenceJson: BlockEvidence;
  /** Set only once a page reached somebody; pageAttempts counts the tries. */
  pagedAt: string | null;
  pageError: string | null;
  pageAttempts: number;
  remindedAt: string | null;
  recoveryNotifiedAt: string | null;
  keptAt: string | null;
  snoozedUntil: string | null;
  actedBy: string | null;
  actionNote: string | null;
  node: { name: string; region: string; status: string };
}

export interface BlockWatchOverview {
  mode: BlockWatchMode;
  country: string;
  lastCycleAt: string | null;
  open: BlockIncident[];
  closed: BlockIncident[];
}

// ------------------------------------------------------- customer activity
//
// What staff see on a customer's profile about their connections. Byte
// counts are decimal strings for the same reason as everywhere else here:
// they come out of BigInt columns and can pass Number.MAX_SAFE_INTEGER.

/** "Connected" is inferred, not reported: a usage record for this
 * customer that ended in the last 10 minutes and carried bytes. A
 * connection that is up but idle, or younger than one usage report, does
 * not count. */
export interface CustomerConnectedNow {
  nodeName: string;
  protocol: string;
  lastTrafficAt: string;
  bytesLast10Min: string;
}

/** One signed-in device: a CustomerSession and what it last reported. */
export interface CustomerDevice {
  sessionId: string;
  /** windows | macos | linux | android | ios; null on sessions from
   * before apps sent it. */
  platform: string | null;
  label: string | null;
  /** NORMAL or RELAY: which route the sign-in arrived by. */
  channel: string | null;
  createdAt: string;
  lastUsedAt: string;
  revoked: boolean;
  appVersion: string | null;
}

/** One rung of a connect attempt's failover ladder, with the server it
 * dialled resolved to a name where the backend could. */
export interface CustomerAttemptRung {
  protocol: string | null;
  server: string | null;
  result: string;
  carried: boolean | null;
}

/** A client attempt as the profile shows it. `kind` and `outcome` carry
 * the ClientAttemptKind / ClientAttemptOutcome values, typed loosely so a
 * value added on the backend renders as itself instead of breaking. */
export interface CustomerAttempt {
  id: string;
  at: string;
  kind: string;
  outcome: string;
  platform: string;
  appVersion: string;
  network: { asn: number; name: string | null } | null;
  /** Null when the report came through one of our servers. */
  ip: string | null;
  /** The server the report came through, when it was sent through the
   * VPN; its address is the server's, not the customer's. */
  throughServer?: string | null;
  protocol: string | null;
  reason: string | null;
  sessionSeconds: number | null;
  rungs: CustomerAttemptRung[];
}

/** One day x server x protocol of usage, last 14 days. `day` is a UTC
 * date, YYYY-MM-DD. */
export interface CustomerTrafficRow {
  day: string;
  nodeName: string;
  protocol: string;
  bytesUp: string;
  bytesDown: string;
}

/** GET /customers/:id/activity */
export interface CustomerActivity {
  now: { lastSeenAt: string | null; connected: CustomerConnectedNow | null };
  devices: CustomerDevice[];
  attempts: CustomerAttempt[];
  traffic: CustomerTrafficRow[];
}

/** GET /monitor/live -- customers with traffic in the last 10 minutes. */
export interface LiveMonitor {
  at: string;
  users: {
    customerId: string;
    email: string;
    nodeName: string;
    protocol: string;
    lastTrafficAt: string;
    bytesLast10Min: string;
  }[];
}
