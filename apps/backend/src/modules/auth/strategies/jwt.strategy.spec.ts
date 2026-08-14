import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdminRole } from "@prisma/client";
import { JwtStrategy } from "./jwt.strategy";

/**
 * The MFA bypass this closes.
 *
 * AuthService.login() signs `{sub, purpose: "mfa"}` with the SAME
 * `jwt.accessSecret` that signs access tokens, and hands it back after
 * the password is accepted but before any TOTP code is seen. The
 * strategy used to copy `sub` through without checking anything, and
 * RolesGuard only rejects on endpoints that declare @Roles() -- which
 * most admin controllers do not. So a stolen password alone bought five
 * minutes of authenticated access to the customer list, everyone's VPN
 * credentials and DELETE /routes, renewable by logging in again.
 */
describe("JwtStrategy.validate", () => {
  const strategy = new JwtStrategy({ get: () => "test-secret" } as unknown as ConfigService);

  it("accepts a real access token", () => {
    expect(strategy.validate({ sub: "admin-1", email: "a@b.c", role: AdminRole.SUPERADMIN })).toEqual({
      sub: "admin-1",
      email: "a@b.c",
      role: AdminRole.SUPERADMIN,
    });
  });

  it("refuses an MFA challenge token presented as a session", () => {
    expect(() =>
      strategy.validate({ sub: "admin-1", purpose: "mfa" } as never),
    ).toThrow(UnauthorizedException);
  });

  it("refuses any other purpose-scoped token signed with the same secret", () => {
    expect(() =>
      strategy.validate({ sub: "admin-1", email: "a@b.c", role: AdminRole.SUPERADMIN, purpose: "anything" }),
    ).toThrow(UnauthorizedException);
  });

  it("refuses a token whose role is not a real role", () => {
    // Belt and braces for the same class of bug: something signed with
    // this secret that happens to carry a role-shaped field.
    expect(() => strategy.validate({ sub: "a", email: "a@b.c", role: "OWNER" as AdminRole })).toThrow(
      UnauthorizedException,
    );
  });

  it("refuses a token with no role at all", () => {
    expect(() => strategy.validate({ sub: "a", email: "a@b.c" } as never)).toThrow(UnauthorizedException);
  });
});
