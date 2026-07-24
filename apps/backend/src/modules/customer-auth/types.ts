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
