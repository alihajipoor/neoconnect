import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectRoutes, type RouteInfo } from "../../../test/routes";
import { RELAY_ALLOWLIST, RELAY_IRAN_ONLY, relayAllows, relayNeedsIran } from "./relay-allowlist";

const UUID = "3f2b8c1e-9a4d-4e6f-8b0a-1c2d3e4f5a6b";

/** A concrete request target for a route pattern. */
function target(route: { path: string }): string {
  return route.path.replace(/:[^/]+/g, UUID);
}

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("the relay allowlist", () => {
  let routes: RouteInfo[];

  beforeAll(() => {
    routes = collectRoutes();
  }, 120_000);

  /** Pinned, so widening what the relay carries is a visible change to a
   * test rather than a line slipped into a list. */
  it("is exactly this list", () => {
    expect(RELAY_ALLOWLIST.map(key).sort()).toEqual(
      [
        "GET /health",
        "GET /endpoints/bundle",
        "GET /relay/status",
        "POST /login-challenge",
        "POST /customer-auth/login",
        "POST /customer-auth/register",
        "POST /customer-auth/relay-register",
        "POST /customer-auth/refresh",
        "POST /customer-auth/logout",
        "POST /customer-auth/social",
        "POST /customer-auth/social/exchange",
        "POST /customer-auth/verify-email-code",
        "POST /customer-auth/resend-verification",
        "POST /customer-auth/forgot-password",
        "POST /customer-auth/reset-password-code",
        "POST /customer-auth/reset-password-recovery",
        "POST /customer-auth/change-password",
        "POST /customer-auth/set-password",
        "POST /customer-auth/unverified-email",
        "POST /customer-auth/recovery-code",
        "GET /customer/me",
        "GET /customer/subscriptions",
        "GET /customer/protocol-users",
        "GET /customer/subscriptions/:id/routes",
        "POST /customer/subscriptions/:id/route",
        "POST /customer/vouchers/preview",
        "POST /customer/vouchers/redeem",
        "GET /customer/plans",
        "GET /customer/billing/providers",
        "POST /customer/subscriptions",
        "POST /customer/billing/payments",
        "POST /client-attempts",
      ].sort(),
    );
    expect(RELAY_IRAN_ONLY.map(key)).toEqual(["POST /customer-auth/relay-register"]);
  });

  it("names only routes the backend actually serves", () => {
    const served = new Set(routes.map(key));
    for (const entry of RELAY_ALLOWLIST) {
      expect(served).toContain(key(entry));
    }
  });

  /** Enumerated from the router: a route added later is refused unless
   * someone adds it to the list on purpose. */
  it("refuses every other route the backend serves", () => {
    const allowed = new Set(RELAY_ALLOWLIST.map(key));
    expect(routes.length).toBeGreaterThan(100);
    for (const route of routes) {
      expect([key(route), relayAllows(route.method, target(route))]).toEqual([key(route), allowed.has(key(route))]);
    }
  });

  it("refuses near misses of an allowed call", () => {
    for (const [method, url] of [
      ["GET", "/health/"],
      ["GET", "/health?x=1"],
      ["GET", "/health?"],
      ["GET", "/health#x"],
      ["GET", "/HEALTH"],
      ["HEAD", "/health"],
      ["OPTIONS", "/health"],
      ["get", "/health"],
      ["GET", "//health"],
      ["GET", "/api/health"],
      ["GET", "/health/ip"],
      ["GET", "/customer/../health"],
      ["GET", "/customer%2Fme"],
      ["POST", "/customer/me"],
      ["GET", "/customer-auth/login"],
      ["GET", "/customer/subscriptions/not-a-uuid/routes"],
      ["GET", `/customer/subscriptions/${UUID}/routes/x`],
      ["GET", `/customer/subscriptions//${UUID}/routes`],
      ["POST", "/customer/vpn/claim"],
      ["GET", "/customer/support"],
      ["POST", "/customer/billing/apple/redeem"],
      ["DELETE", "/customer/me"],
    ]) {
      expect([method, url, relayAllows(method, url)]).toEqual([method, url, false]);
    }
  });

  /** The origin's template carries the same list, so the two cannot drift
   * without a test saying so. */
  it("matches the origin's nginx template", () => {
    const template = readFileSync(join(__dirname, "..", "..", "..", "..", "..", "infra", "nginx", "relay-origin.conf.example"), "utf8");
    const exact = [...template.matchAll(/^\s*"(GET|POST) \/api(\/[^"~]*)" 1;$/gm)].map((m) => `${m[1]} ${m[2]}`);
    const patterns = [...template.matchAll(/^\s*"~\^(GET|POST) \/api(\/[^"]*)\$" 1;$/gm)].map(
      (m) => `${m[1]} ${m[2].replace(/\[0-9a-fA-F\]\{8\}(-\[0-9a-fA-F\]\{4\}){3}-\[0-9a-fA-F\]\{12\}/, ":id")}`,
    );
    expect([...exact, ...patterns].sort()).toEqual(RELAY_ALLOWLIST.map(key).sort());
  });

  it("asks for an Iranian network only on the sign-up that skips verification", () => {
    expect(relayNeedsIran("POST", "/customer-auth/relay-register")).toBe(true);
    expect(relayNeedsIran("POST", "/customer-auth/login")).toBe(false);
    expect(relayNeedsIran("POST", "/customer-auth/register")).toBe(false);
  });
});
