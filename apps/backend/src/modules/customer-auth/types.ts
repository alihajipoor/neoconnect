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
// even though both are signed with customerJwt.accessSecret -- the
// `purpose` discriminator is checked explicitly wherever each is
// verified, so a real access token can never be replayed as one of these
// and vice versa. Same pattern as the admin side's MfaTokenPayload.
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
