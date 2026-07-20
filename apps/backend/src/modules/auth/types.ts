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
