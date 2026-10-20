/** The panel's session cookies and what can be read from their tokens
 * without the backend: only when they expire. Never verified here -- the
 * backend verifies every token it is handed -- so nothing read here
 * grants anything; it only decides when to ask for a renewal.
 *
 * Kept free of next/headers and server-only so the proxy can use it. */

export const ACCESS_COOKIE = "neoxify_access";
export const REFRESH_COOKIE = "neoxify_refresh";

/** Renew this long before the access token runs out, so a page that takes
 * a moment to render does not see it expire halfway. */
export const RENEW_WITHIN_SECONDS = 120;

export function decodeJwtPayload<T>(token: string): T | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Seconds until the token's `exp`; negative once past. Null when it has
 * none or cannot be read. */
export function secondsLeft(token: string | undefined, now: number = Date.now()): number | null {
  if (!token) return null;
  const exp = decodeJwtPayload<{ exp?: unknown }>(token)?.exp;
  return typeof exp === "number" ? Math.floor(exp - now / 1000) : null;
}

/** A renewal is due: there is a live refresh token, and the access token
 * is missing, unreadable or about to run out. */
export function needsRenewal(access: string | undefined, refresh: string | undefined, now: number = Date.now()): boolean {
  const refreshLeft = secondsLeft(refresh, now);
  if (refreshLeft === null || refreshLeft <= 0) return false;
  const accessLeft = secondsLeft(access, now);
  return accessLeft === null || accessLeft <= RENEW_WITHIN_SECONDS;
}

/** The cookie lives exactly as long as its token. */
export function cookieOptions(token: string, secure: boolean, now: number = Date.now()) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.max(1, secondsLeft(token, now) ?? 60),
  };
}
