import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { AuthenticatedCustomer, CustomerAccessTokenPayload } from "../types";

// Named "customer-jwt", not "jwt" -- Passport strategies are name-keyed
// singletons, so this must be distinct from AuthModule's admin "jwt"
// strategy (apps/backend/src/modules/auth/strategies/jwt.strategy.ts).
// Validates against a wholly separate secret (customerJwt.accessSecret,
// not jwt.accessSecret) so admin and customer sessions are
// cryptographically isolated, not just shape-isolated.
@Injectable()
export class CustomerJwtStrategy extends PassportStrategy(Strategy, "customer-jwt") {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>("customerJwt.accessSecret") as string,
    });
  }

  /**
   * Accepts ONLY a real access token, checked positively.
   *
   * Isolation from the ADMIN secret was never the exposure here. Three
   * other things are signed with `customerJwt.accessSecret` and were all
   * accepted as sessions by the version of this that only read `sub`:
   *
   *   - the email-verification token (`purpose: "verify-email"`, 24h,
   *     `sub` = a real customer id). It is emailed in cleartext and also
   *     travels in the query string of GET /customer-auth/verify-email/open,
   *     so it lands in access logs and browser history. Anyone who saw one
   *     held a full 24-hour session for that account -- password not
   *     required, and no password change would end it.
   *   - the password-reset token (`purpose: "password-reset"`), same shape.
   *   - the emailed invoice-document token (`purpose: "invoice-document"`),
   *     whose `sub` is an INVOICE id, which would then have been used as a
   *     customer id by every handler downstream.
   *
   * types.ts said the `purpose` discriminator made replay impossible
   * "and vice versa". Only the first half was ever true: each purpose
   * checks its own claim, but nothing rejected a purpose token presented
   * as a session. Both halves are enforced now.
   */
  validate(payload: CustomerAccessTokenPayload & { purpose?: unknown }): AuthenticatedCustomer {
    if (payload.purpose !== undefined) {
      throw new UnauthorizedException("This token is not an access token");
    }
    if (typeof payload.sub !== "string" || typeof payload.email !== "string" || payload.email === "") {
      throw new UnauthorizedException("This token is not an access token");
    }
    return { sub: payload.sub, email: payload.email };
  }
}
