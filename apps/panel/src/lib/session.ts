import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieOptions, decodeJwtPayload } from "./session-tokens";

export { ACCESS_COOKIE, REFRESH_COOKIE };

export type AdminRole = "SUPERADMIN" | "SUPPORT" | "BILLING" | "RESELLER";

export interface SessionAdmin {
  sub: string;
  email: string;
  role: AdminRole;
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

/**
 * Send outsider roles away from a staff-only page.
 *
 * A reseller is not staff: they hold a panel login so they can mint
 * their own vouchers, and nothing else here is theirs. The sidebar has
 * hidden the rest from them since M25, but hiding a link does not stop
 * anyone typing the URL -- and /overview leaked exactly that way once
 * already, found by signing in as a reseller rather than by reading
 * code.
 *
 * This is the second layer, not the boundary: JwtAuthGuard on the
 * backend refuses an outsider role on any endpoint that does not name
 * it, so a page reached anyway renders nothing of anyone else's. What
 * this adds is landing them somewhere that works instead of on a screen
 * full of 403s.
 *
 * Call it at the top of every page that is not the reseller's own.
 */
export async function requireStaff(): Promise<SessionAdmin> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "RESELLER") redirect("/reseller");
  return session;
}

export async function getAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value ?? null;
}

/** Only callable from a Server Action or Route Handler. Each cookie lives
 * as long as its token: the backend decides the session's length, and the
 * proxy (src/proxy.ts) renews it while it is in use. */
export async function setSessionCookies(tokens: { accessToken: string; refreshToken: string }) {
  const store = await cookies();
  const secure = process.env.NODE_ENV === "production";
  store.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(tokens.accessToken, secure));
  store.set(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(tokens.refreshToken, secure));
}

/** Only callable from a Server Action or Route Handler. */
export async function clearSessionCookies() {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}
