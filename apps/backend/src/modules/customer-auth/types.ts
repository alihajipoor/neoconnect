export interface AuthenticatedCustomer {
  sub: string;
  email: string;
}

export interface CustomerAccessTokenPayload {
  sub: string;
  email: string;
}

export interface CustomerRefreshTokenPayload {
  sub: string;
  tokenVersion: number;
}

// Deliberately separate shapes (not reusing CustomerAccessTokenPayload)
// even though both are signed with customerJwt.accessSecret. Each
// purpose is checked where it is verified, so an access token cannot be
// spent as a verification or reset token.
//
// "And vice versa" was claimed here and was false until 2026-08-14:
// CustomerJwtStrategy read only `sub`, so an emailed verify-email token
// -- 24 hours, cleartext in an inbox, and in the query string of the
// GET landing page -- was accepted as a full customer session. The
// strategy now rejects any token carrying a `purpose` claim.
export interface CustomerVerifyEmailTokenPayload {
  sub: string;
  purpose: "verify-email";
}

export interface CustomerPasswordResetTokenPayload {
  sub: string;
  purpose: "password-reset";
}

// Returned by register()/login() instead of a token pair when the
// account hasn't verified its email yet -- neither issues a usable
// session until then (2026-07-24 decision: no login without
// verification, not just no VPN access). Mirrors the admin side's
// `{mfaRequired: true, mfaToken}` shape from AuthService.login().
export interface CustomerRequiresVerification {
  requiresVerification: true;
  email: string;
}
