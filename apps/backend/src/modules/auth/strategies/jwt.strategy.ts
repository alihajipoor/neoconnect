import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { AdminRole } from "@prisma/client";
import { ExtractJwt, Strategy } from "passport-jwt";
import { AccessTokenPayload, AuthenticatedAdmin } from "../types";

const ADMIN_ROLES = new Set<string>(Object.values(AdminRole));

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>("jwt.accessSecret") as string,
    });
  }

  /**
   * Accepts ONLY a real access token, checked positively.
   *
   * `jwt.accessSecret` signs more than access tokens: AuthService.login()
   * signs the MFA challenge token with it too. types.ts claimed that was
   * safe because "an mfaToken has no `role`, so it can't pass as an
   * access token to JwtStrategy.validate()" -- but nothing here checked,
   * and RolesGuard only rejects on routes that declare @Roles(). Most
   * admin controllers declare none (customers, protocol-users, routes,
   * protocol-configs...), so an mfaToken -- issued after the password
   * and BEFORE the TOTP code -- authenticated against all of them. That
   * is a complete MFA bypass for anyone holding a stolen password, for
   * the five minutes the challenge lives, renewable by logging in again.
   *
   * So: reject anything carrying a `purpose` claim (mfa, verify-email,
   * password-reset, invoice-document all use one), and require the
   * fields only a genuine access token has. Checking positively means a
   * future purpose-scoped token invented without reading this comment is
   * refused by default rather than accepted by omission.
   */
  validate(payload: AccessTokenPayload & { purpose?: unknown }): AuthenticatedAdmin {
    if (payload.purpose !== undefined) {
      throw new UnauthorizedException("This token is not an access token");
    }
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
      throw new UnauthorizedException("This token is not an access token");
    }
    if (typeof payload.role !== "string" || !ADMIN_ROLES.has(payload.role)) {
      throw new UnauthorizedException("This token is not an access token");
    }
    return { sub: payload.sub, email: payload.email, role: payload.role };
  }
}
