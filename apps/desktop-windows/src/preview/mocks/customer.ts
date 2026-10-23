/** DEV ONLY: the account API answered from samples, for the dev preview of
 * Settings, Plans, Support and Invite friends. Swapped in for
 * `src/lib/customer.ts` by the `nx-preview-mocks` plugin in vite.config.ts,
 * and only when the dev server is started with NX_PREVIEW_MOCKS=1; never
 * part of a build. Everything not overridden here is the real module.
 *
 * Nothing leaves the page: these answer at once from the samples below. */

export * from "../../lib/customer";
import type { ApiResult } from "../../lib/api";
import type {
  AppLinks,
  Customer,
  ReferralOverview,
  Subscription,
  SubscriptionPlan,
  SupportOverview,
  SupportThread,
} from "../../lib/types";

const ok = <T>(data: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, data });
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const GB = 1024 ** 3;

export const SAMPLE_ME: Customer = {
  id: "c1",
  email: "you@example.com",
  telegramId: null,
  referralCode: "NX7Q2K",
  status: "ACTIVE",
  emailVerifiedAt: ago(40 * DAY),
  createdAt: ago(60 * DAY),
  updatedAt: ago(DAY),
  signupChannel: "NORMAL",
  relayUnverifiedSince: null,
  hasPassword: true,
  hasRecoveryCode: false,
};

function plan(id: string, name: string, priceUsd: string, capGb: number | null, devices: number, mbps: number | null): SubscriptionPlan {
  return {
    id,
    name,
    dataCapBytes: capGb === null ? null : String(capGb * GB),
    durationDays: 30,
    priceUsd,
    maxConcurrentConnections: devices,
    maxDownloadMbps: mbps,
    maxUploadMbps: mbps,
    protocolsAllowed: ["XRAY_VLESS_REALITY", "WIREGUARD"],
    appleProductId: null,
    isActive: true,
    defaultRouteId: null,
    createdAt: ago(90 * DAY),
    updatedAt: ago(90 * DAY),
  };
}

export const SAMPLE_PLANS: SubscriptionPlan[] = [
  plan("p-starter", "Starter", "2.99", 50, 1, 50),
  plan("p-standard", "Standard", "4.99", null, 2, null),
  plan("p-ultimate", "Ultimate", "9.99", null, 5, null),
];

export const SAMPLE_SUBSCRIPTION: Subscription = {
  id: "s1",
  customerId: "c1",
  planId: "p-ultimate",
  primaryNodeId: null,
  status: "ACTIVE",
  startAt: ago(24 * DAY),
  expireAt: new Date(Date.now() + 6 * DAY).toISOString(),
  dataCapBytes: null,
  dataUsedBytes: String(Math.round(7.2 * GB)),
  autoRenew: false,
  createdAt: ago(24 * DAY),
  updatedAt: ago(DAY),
  deviceLimit: 5,
};

export const getMe = () => ok(SAMPLE_ME);
export const getPlans = () => ok(SAMPLE_PLANS);
export const getSubscriptions = () => ok([SAMPLE_SUBSCRIPTION]);
export const getAppLinks = () =>
  ok<AppLinks>({
    websiteUrl: "https://example.com",
    discordUrl: "https://example.com/discord",
    instagramUrl: null,
    telegramUrl: "https://example.com/telegram",
  });

export const getReferrals = () =>
  ok<ReferralOverview>({
    enabled: true,
    code: "NX7Q2K",
    rules: { loyalFriendMonths: 3, friendsRequired: 3, friendMonths: 1, rewardDays: 30 },
    friends: [
      { maskedEmail: "a***@example.com", joinedAt: ago(20 * DAY), activated: true, paidMonths: 1 },
      { maskedEmail: "m***@example.org", joinedAt: ago(9 * DAY), activated: true, paidMonths: 0 },
      { maskedEmail: "s***@example.net", joinedAt: ago(2 * DAY), activated: false, paidMonths: 0 },
    ],
    rewards: [],
    progress: { monthsToNextReward: 2, qualifyingFriends: 1, bestFriendMonths: 1 },
  });

export const getSupportOverview = () =>
  ok<SupportOverview>({
    acceptingTickets: true,
    awayMessage: null,
    replyWithinHours: 24,
    tickets: [
      { id: "t1", subject: "Can't connect on Stealth from home", status: "ANSWERED", lastMessageAt: ago(3 * 3600_000), createdAt: ago(DAY), unread: true },
      { id: "t2", subject: "Voucher code question", status: "RESOLVED", lastMessageAt: ago(12 * DAY), createdAt: ago(13 * DAY), unread: false },
    ],
  });

export const getSupportThread = (id: string) =>
  ok<SupportThread>({
    id,
    subject: "Can't connect on Stealth from home",
    status: "ANSWERED",
    lastMessageAt: ago(3 * 3600_000),
    messages: [
      { id: "m1", fromAdmin: false, body: "Stealth stopped connecting at home this morning. Fast still works.", createdAt: ago(DAY) },
      { id: "m2", fromAdmin: true, body: "Thanks. Could you try Stealth Web, and send us the diagnostics from this page?", createdAt: ago(3 * 3600_000) },
    ],
  });
