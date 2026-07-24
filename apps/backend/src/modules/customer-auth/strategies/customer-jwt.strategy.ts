import { Injectable } from "@nestjs/common";
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

  validate(payload: CustomerAccessTokenPayload): AuthenticatedCustomer {
    return { sub: payload.sub, email: payload.email };
  }
}
