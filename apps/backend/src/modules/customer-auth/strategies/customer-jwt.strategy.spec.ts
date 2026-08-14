import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CustomerJwtStrategy } from "./customer-jwt.strategy";

/**
 * Three different tokens are signed with `customerJwt.accessSecret`, and
 * the strategy used to accept all of them as a customer session because
 * it read only `sub`:
 *
 *   - verify-email  (24h, `sub` = a real customer id) -- emailed in
 *     cleartext and carried in the query string of the GET landing page,
 *     so it survives in mail archives, access logs and browser history.
 *     Anyone who saw one held that account for a day, with no password.
 *   - password-reset (same shape).
 *   - invoice-document, whose `sub` is an INVOICE id, which every
 *     handler downstream would then have treated as a customer id.
 */
describe("CustomerJwtStrategy.validate", () => {
  const strategy = new CustomerJwtStrategy({ get: () => "test-secret" } as unknown as ConfigService);

  it("accepts a real access token", () => {
    expect(strategy.validate({ sub: "cust-1", email: "a@b.c" })).toEqual({ sub: "cust-1", email: "a@b.c" });
  });

  it("refuses an email-verification token presented as a session", () => {
    expect(() => strategy.validate({ sub: "cust-1", purpose: "verify-email" } as never)).toThrow(
      UnauthorizedException,
    );
  });

  it("refuses a password-reset token presented as a session", () => {
    expect(() => strategy.validate({ sub: "cust-1", purpose: "password-reset" } as never)).toThrow(
      UnauthorizedException,
    );
  });

  it("refuses an invoice-document token, whose sub is not even a customer", () => {
    expect(() => strategy.validate({ sub: "invoice-1", purpose: "invoice-document" } as never)).toThrow(
      UnauthorizedException,
    );
  });

  it("refuses a token with no email, which no issued access token lacks", () => {
    expect(() => strategy.validate({ sub: "cust-1" } as never)).toThrow(UnauthorizedException);
  });
});
