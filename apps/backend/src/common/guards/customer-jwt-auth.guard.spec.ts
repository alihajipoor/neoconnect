import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { collectRoutes, type RouteInfo } from "../../../test/routes";
import { ALLOW_UNVERIFIED, CustomerJwtAuthGuard, forgetVerified } from "./customer-jwt-auth.guard";

/** What an account with an unconfirmed address may do, on any route
 * (docs/relay-last-resort.md, R3.3). Pinned: a change here is a change to
 * what an unverified account holds. */
const UNVERIFIED_MAY = [
  "POST /customer-auth/logout",
  "POST /customer-auth/change-password",
  "POST /customer-auth/unverified-email",
  "POST /customer-auth/recovery-code",
  "GET /customer/me",
  // Account deletion is required in-app by both stores, whoever made the
  // account (Apple 5.1.1(v)).
  "DELETE /customer/me",
  "GET /customer/subscriptions",
  "GET /customer/protocol-users",
  "GET /customer/subscriptions/:id/routes",
  "POST /customer/subscriptions/:id/route",
  "POST /customer/vouchers/preview",
  "POST /customer/vouchers/redeem",
  // Device slots: what a paid Ultimate account needs to connect on the
  // apps in the field, which claim before connecting.
  "POST /customer/vpn/claim",
  "POST /customer/vpn/renew",
  "POST /customer/vpn/release",
].sort();

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

function contextFor(route: RouteInfo, user: { sub: string; email: string }): ExecutionContext {
  const req = { user };
  return {
    getHandler: () => (route.controller.prototype as Record<string, unknown>)[route.handler],
    getClass: () => route.controller,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("CustomerJwtAuthGuard", () => {
  let routes: RouteInfo[];
  let guarded: RouteInfo[];

  beforeAll(() => {
    routes = collectRoutes();
    guarded = routes.filter((r) => r.guards.includes(CustomerJwtAuthGuard));
  }, 120_000);

  beforeEach(() => {
    // The session part is passport's and is tested with the strategy;
    // here every token is a good one.
    const parent = Object.getPrototypeOf(CustomerJwtAuthGuard.prototype) as { canActivate: () => Promise<boolean> };
    jest.spyOn(parent, "canActivate").mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function guardFor(customer: { emailVerifiedAt: Date | null } | null) {
    const prisma = { customer: { findUnique: jest.fn().mockResolvedValue(customer) } };
    return { guard: new CustomerJwtAuthGuard(new Reflector(), prisma as any), prisma };
  }

  it("guards every /customer route but the checkout's return page", () => {
    const unguarded = routes
      .filter((r) => r.path === "/customer" || r.path.startsWith("/customer/"))
      .filter((r) => !r.guards.includes(CustomerJwtAuthGuard))
      .map(key);
    // Where the card provider sends the browser after paying: a page, with
    // no session and nothing to hold (modules/billing/webhooks.controller.ts).
    expect(unguarded).toEqual(["GET /customer/billing/return"]);
    expect(guarded.length).toBeGreaterThan(UNVERIFIED_MAY.length);
  });

  it("lets an unverified account use exactly the capability set", () => {
    const marked = guarded
      .filter((r) => {
        const handler = (r.controller.prototype as Record<string, unknown>)[r.handler] as object;
        return Reflect.getMetadata(ALLOW_UNVERIFIED, handler) || Reflect.getMetadata(ALLOW_UNVERIFIED, r.controller);
      })
      .map(key)
      .sort();
    expect(marked).toEqual(UNVERIFIED_MAY);
  });

  /** Enumerated from the router: a customer route added later is refused
   * to an unverified account unless someone marks it on purpose. */
  it("refuses an unverified account every other customer route with VERIFY_EMAIL", async () => {
    const user = { sub: "c-unverified", email: "u@example.com" };
    forgetVerified(user.sub);
    const { guard } = guardFor({ emailVerifiedAt: null });
    for (const route of guarded) {
      const outcome = await guard.canActivate(contextFor(route, user)).then(
        () => "allowed",
        (err: unknown) =>
          err instanceof ForbiddenException ? (err.getResponse() as { code?: string }).code : String(err),
      );
      expect([key(route), outcome]).toEqual([key(route), UNVERIFIED_MAY.includes(key(route)) ? "allowed" : "VERIFY_EMAIL"]);
    }
  });

  it("lets a verified account through everywhere, asking the database once", async () => {
    const user = { sub: "c-verified", email: "v@example.com" };
    forgetVerified(user.sub);
    const { guard, prisma } = guardFor({ emailVerifiedAt: new Date() });
    for (const route of guarded) {
      await expect(guard.canActivate(contextFor(route, user))).resolves.toBe(true);
    }
    expect(prisma.customer.findUnique).toHaveBeenCalledTimes(1);
  });

  it("refuses a token whose account is gone", async () => {
    const user = { sub: "c-gone", email: "g@example.com" };
    forgetVerified(user.sub);
    const { guard } = guardFor(null);
    const route = guarded.find((r) => key(r) === "GET /customer/plans")!;
    await expect(guard.canActivate(contextFor(route, user))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
