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
