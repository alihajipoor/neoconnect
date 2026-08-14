import { AdminRole } from "@prisma/client";

export interface AuthenticatedAdmin {
  sub: string;
  email: string;
  role: AdminRole;
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: AdminRole;
}

export interface RefreshTokenPayload {
  sub: string;
  tokenVersion: number;
}

// Deliberately its own shape (not reusing AccessTokenPayload) even though
// it's signed with the same jwt.accessSecret. AuthService.verifyMfa()
// checks `purpose` so an access token cannot be spent as an mfaToken.
//
// The reverse direction used to be asserted here and was NOT true: this
// comment claimed "a mfaToken has no `role`, so it can't pass as an
// access token to JwtStrategy.validate() either", but validate() copied
// the payload through without looking, and RolesGuard only rejects on
// routes that declare @Roles() -- which most admin controllers do not.
// An mfaToken is issued after the password and before the TOTP code, so
// that was a five-minute MFA bypass. JwtStrategy.validate() now rejects
// any token carrying a `purpose` claim; the invariant is enforced rather
// than described.
export interface MfaTokenPayload {
  sub: string;
  purpose: "mfa";
}
