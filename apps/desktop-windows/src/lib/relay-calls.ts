/** The calls the relay of last resort may carry, as the screens see them.
 *
 * A mirror of `allowed_call` in src-tauri/src/relay_http.rs, which is the
 * authority on this side: whatever this says, the Rust command refuses a
 * call that is not on its own list before it opens a socket. This copy
 * exists so the app can decide what to offer -- a request that cannot go
 * through the relay is never routed towards it, and so never prompts for
 * consent or spends the budget on a refusal.
 *
 * relay-calls.test.ts reads relay_http.rs and the backend's own list
 * (`RELAY_ALLOWLIST`) and fails if this drifts from either. The backend
 * carries two calls the app does not: card and crypto checkout, which
 * cannot be completed through the relay until the payment-only path
 * exists (docs/relay-last-resort.md).
 */

const POST_PATHS: readonly string[] = [
  "/login-challenge",
  "/customer-auth/login",
  "/customer-auth/register",
  "/customer-auth/relay-register",
  "/customer-auth/refresh",
  "/customer-auth/logout",
  "/customer-auth/social",
  "/customer-auth/social/exchange",
  "/customer-auth/verify-email-code",
  "/customer-auth/resend-verification",
  "/customer-auth/forgot-password",
  "/customer-auth/reset-password-code",
  "/customer-auth/reset-password-recovery",
  "/customer-auth/recovery-code",
  "/customer-auth/change-password",
  "/customer-auth/set-password",
  "/customer-auth/unverified-email",
  "/customer/vouchers/preview",
  "/customer/vouchers/redeem",
];

const GET_PATHS: readonly string[] = [
  "/customer/me",
  "/customer/subscriptions",
  "/customer/protocol-users",
  "/customer/plans",
  "/customer/billing/providers",
  "/health",
  "/endpoints/bundle",
  "/endpoints/bundle2",
  "/relay/status",
];

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function subscriptionCall(path: string, tail: string): boolean {
  const prefix = "/customer/subscriptions/";
  if (!path.startsWith(prefix) || !path.endsWith(tail)) return false;
  return UUID.test(path.slice(prefix.length, path.length - tail.length));
}

/** Whether the relay may carry `method` to `path` (relative to `/api`),
 * matched exactly as `allowed_call` matches it. */
export function relayAllows(method: string, path: string): boolean {
  if (method === "GET") return GET_PATHS.includes(path) || subscriptionCall(path, "/routes");
  if (method === "POST") return POST_PATHS.includes(path) || subscriptionCall(path, "/route");
  return false;
}

/** The fixed lists, for relay-calls.test.ts. */
export const RELAY_CALLS = { POST: POST_PATHS, GET: GET_PATHS } as const;
