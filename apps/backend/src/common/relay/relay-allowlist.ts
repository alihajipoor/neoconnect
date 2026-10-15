/** What a request that arrived through the Iranian relay may reach
 * (docs/relay-last-resort.md, R2.2).
 *
 * The relay listener serves the same application as the normal one, and
 * this list is what makes it a different door: anything not on it gets a
 * bare 404 before any controller runs. It mirrors the client's own list
 * (`allowed_call` in apps/desktop-windows/src-tauri/src/relay_http.rs)
 * and the origin's relay server block (infra/nginx/relay-origin.conf.example);
 * the three are kept in step by hand, and this one is the authority.
 *
 * Paths are the backend's own, without the `/api` the origin strips.
 * Matched exactly: a query string, a trailing slash, a doubled or encoded
 * slash, a different case or a `..` is simply not on the list. A `:id`
 * segment matches only the shape of a UUID.
 *
 * Changes here are deliberate: relay-allowlist.spec.ts pins the list, and
 * checks every entry against the router so a typo or a renamed route
 * fails a test instead of failing a customer in Iran.
 */

export type RelayMethod = "GET" | "POST";

export interface RelayRoute {
  method: RelayMethod;
  path: string;
}

export const RELAY_ALLOWLIST: readonly RelayRoute[] = [
  // Reachability and the signed endpoint bundle.
  { method: "GET", path: "/health" },
  { method: "GET", path: "/endpoints/bundle" },
  { method: "GET", path: "/relay/status" },

  // Signing in, signing up, and the ways back into an account.
  { method: "POST", path: "/login-challenge" },
  { method: "POST", path: "/customer-auth/login" },
  { method: "POST", path: "/customer-auth/register" },
  { method: "POST", path: "/customer-auth/relay-register" },
  { method: "POST", path: "/customer-auth/refresh" },
  // Signing out has to work where signing in does: unverified accounts
  // hold at most three sessions, and a device that cannot sign out over
  // the relay would hold one for a month (F17).
  { method: "POST", path: "/customer-auth/logout" },
  { method: "POST", path: "/customer-auth/social" },
  { method: "POST", path: "/customer-auth/social/exchange" },
  { method: "POST", path: "/customer-auth/verify-email-code" },
  { method: "POST", path: "/customer-auth/resend-verification" },
  { method: "POST", path: "/customer-auth/forgot-password" },
  { method: "POST", path: "/customer-auth/reset-password-code" },
  { method: "POST", path: "/customer-auth/reset-password-recovery" },
  { method: "POST", path: "/customer-auth/change-password" },
  { method: "POST", path: "/customer-auth/unverified-email" },
  { method: "POST", path: "/customer-auth/recovery-code" },

  // The account, and what it needs to connect.
  { method: "GET", path: "/customer/me" },
  { method: "GET", path: "/customer/subscriptions" },
  { method: "GET", path: "/customer/protocol-users" },
  { method: "GET", path: "/customer/subscriptions/:id/routes" },
  { method: "POST", path: "/customer/subscriptions/:id/route" },

  // Paying: vouchers, and creating a card or crypto checkout. The
  // checkout page itself is the provider's and is not reached through
  // here. Unverified accounts are refused all but the vouchers by the
  // CustomerJwtAuthGuard, wherever they come from.
  { method: "POST", path: "/customer/vouchers/preview" },
  { method: "POST", path: "/customer/vouchers/redeem" },
  { method: "GET", path: "/customer/plans" },
  { method: "GET", path: "/customer/billing/providers" },
  { method: "POST", path: "/customer/subscriptions" },
  { method: "POST", path: "/customer/billing/payments" },

  // Failure reports. Stored with the network and never the address.
  { method: "POST", path: "/client-attempts" },
];

/** Calls that skip email verification, which need the caller's network
 * registered in Iran -- not merely unknown (R2.4). */
export const RELAY_IRAN_ONLY: readonly RelayRoute[] = [{ method: "POST", path: "/customer-auth/relay-register" }];

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function matches(route: RelayRoute, method: string, path: string): boolean {
  if (route.method !== method) return false;
  if (!route.path.includes(":")) return route.path === path;
  const want = route.path.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return false;
  return want.every((segment, i) => (segment.startsWith(":") ? UUID.test(got[i]) : segment === got[i]));
}

/** Whether the relay may carry `method` to `url` -- the raw request
 * target, query and all, so that one carrying a query is refused. */
export function relayAllows(method: string, url: string): boolean {
  if (url.includes("?") || url.includes("#")) return false;
  return RELAY_ALLOWLIST.some((route) => matches(route, method, url));
}

/** Whether `method` `url` needs a caller registered in Iran. */
export function relayNeedsIran(method: string, url: string): boolean {
  return RELAY_IRAN_ONLY.some((route) => matches(route, method, url));
}
