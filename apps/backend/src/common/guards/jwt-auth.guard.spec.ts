import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { AdminRole } from "@prisma/client";
import { JwtAuthGuard } from "./jwt-auth.guard";

/**
 * The regression these cover, in one sentence: a RESELLER is an outsider
 * with a panel login, and until 2026-08-14 every admin endpoint that did
 * not name a role let one in.
 *
 * That was not theoretical. `GET /customers`, `GET /protocol-users`
 * (decrypted VPN credentials for every customer), `GET /protocol-configs`
 * (the OpenVPN CA private key lives in publicParamsJson), `GET /routes`
 * (relay uplink credentials), `PATCH /customers/:id` (accepts a new
 * password for anyone) and `DELETE /routes/:id` all declare no @Roles().
 */
describe("JwtAuthGuard", () => {
  // AuthGuard() is memoized per strategy name, so this is the exact
  // prototype JwtAuthGuard extends and `super.canActivate` resolves to.
  const passportPrototype = AuthGuard("jwt").prototype as { canActivate: unknown };
  let authenticated: jest.SpyInstance;

  beforeEach(() => {
    authenticated = jest
      .spyOn(passportPrototype as never, "canActivate")
      .mockResolvedValue(true as never);
  });

  afterEach(() => authenticated.mockRestore());

  function contextFor(role: AdminRole) {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      // Passport has already populated request.user by the time the
      // role check runs -- that ordering is the reason this lives in
      // the authentication guard and not in a global one.
      switchToHttp: () => ({ getRequest: () => ({ user: { sub: "a", email: "a@b.c", role } }) }),
    } as unknown as ExecutionContext;
  }

  const reflectorReturning = (roles: AdminRole[] | undefined) =>
    ({ getAllAndOverride: () => roles }) as unknown as Reflector;

  it("refuses a reseller on an endpoint that declares no roles", async () => {
    const guard = new JwtAuthGuard(reflectorReturning(undefined));
    await expect(guard.canActivate(contextFor(AdminRole.RESELLER))).rejects.toThrow(ForbiddenException);
  });

  it("lets a reseller through where the endpoint names their role", async () => {
    // /reseller/* -- their own balances and codes, scoped to them by the
    // service. Naming the role is now the only way in.
    const guard = new JwtAuthGuard(reflectorReturning([AdminRole.RESELLER, AdminRole.SUPERADMIN]));
    await expect(guard.canActivate(contextFor(AdminRole.RESELLER))).resolves.toBe(true);
  });

  it("does not decide role membership itself -- RolesGuard still does", async () => {
    // A declared list is deferred to, even one the caller is absent
    // from: two guards making the same call from different metadata is
    // how you get a disagreement nobody notices.
    const guard = new JwtAuthGuard(reflectorReturning([AdminRole.SUPERADMIN]));
    await expect(guard.canActivate(contextFor(AdminRole.RESELLER))).resolves.toBe(true);
  });

  it.each([AdminRole.SUPERADMIN, AdminRole.SUPPORT, AdminRole.BILLING])(
    "leaves staff role %s unaffected on an endpoint with no roles",
    async (role) => {
      const guard = new JwtAuthGuard(reflectorReturning(undefined));
      await expect(guard.canActivate(contextFor(role))).resolves.toBe(true);
    },
  );

  it("still refuses when authentication itself fails", async () => {
    authenticated.mockResolvedValue(false as never);
    const guard = new JwtAuthGuard(reflectorReturning(undefined));
    await expect(guard.canActivate(contextFor(AdminRole.SUPERADMIN))).resolves.toBe(false);
  });
});
