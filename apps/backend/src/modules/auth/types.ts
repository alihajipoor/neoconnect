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
// it's signed with the same jwt.accessSecret -- the `purpose` discriminator
// is checked explicitly in AuthService.verifyMfa() so a real access token
// can never be replayed as an mfaToken (it has no `purpose` field) and vice
// versa (a mfaToken has no `role`, so it can't pass as an access token to
// JwtStrategy.validate() either).
export interface MfaTokenPayload {
  sub: string;
  purpose: "mfa";
}
