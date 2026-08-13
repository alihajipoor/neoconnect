import "server-only";
import { cookies } from "next/headers";

export const ACCESS_COOKIE = "neoxify_access";
export const REFRESH_COOKIE = "neoxify_refresh";

export type AdminRole = "SUPERADMIN" | "SUPPORT" | "BILLING" | "RESELLER";

export interface SessionAdmin {
  sub: string;
  email: string;
  role: AdminRole;
}

/** Decodes the JWT payload without verifying the signature -- fine for UX
 * decisions like "should we redirect to /login", since the backend always
 * re-verifies the signature on every request regardless. */
function decodeJwtPayload<T>(token: string): T | null {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionAdmin | null> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (!token) return null;

  const payload = decodeJwtPayload<SessionAdmin & { exp: number }>(token);
  if (!payload) return null;
  if (payload.exp * 1000 < Date.now()) return null;

  return { sub: payload.sub, email: payload.email, role: payload.role };
}

export async function getAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value ?? null;
}

/** Only callable from a Server Action or Route Handler. */
export async function setSessionCookies(tokens: { accessToken: string; refreshToken: string }) {
  const store = await cookies();
  const secure = process.env.NODE_ENV === "production";

  store.set(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 15,
  });
  store.set(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

/** Only callable from a Server Action or Route Handler. */
export async function clearSessionCookies() {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}
