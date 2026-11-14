/** The trusted-device cookies ("Trust this device for 30 days"), as pure
 * values so their flags can be tested without next/headers.
 *
 * - TRUSTED_COOKIE holds the secret: the token the backend swaps for a
 *   skipped code step after a right password. HttpOnly, so no script on
 *   any page can read it, and scoped to /login, the only path whose
 *   requests (the sign-in server action) need it. The browser sends it
 *   nowhere else in the panel.
 * - TRUSTED_ID_COOKIE holds the device's row id, which is no secret: it
 *   only lets the account page mark "this device" and clear the secret
 *   when that device is removed. HttpOnly too, on the whole panel.
 *
 * Both last until the device's fixed expiry, at most 30 days. */

export const TRUSTED_COOKIE = "neoxify_trusted";
export const TRUSTED_ID_COOKIE = "neoxify_trusted_id";
export const TRUSTED_COOKIE_PATH = "/login";

const MAX_SECONDS = 30 * 24 * 3600;

export interface TrustedDeviceGrant {
  token: string;
  id: string;
  /** ISO time, as the backend's JSON carries it. */
  expiresAt: string;
}

function maxAge(expiresAt: string, now: number): number {
  const left = Math.floor((new Date(expiresAt).getTime() - now) / 1000);
  return Number.isFinite(left) ? Math.min(MAX_SECONDS, Math.max(0, left)) : 0;
}

export function trustedCookieOptions(expiresAt: string, secure: boolean, now: number = Date.now()) {
  return { httpOnly: true, secure, sameSite: "strict" as const, path: TRUSTED_COOKIE_PATH, maxAge: maxAge(expiresAt, now) };
}

export function trustedIdCookieOptions(expiresAt: string, secure: boolean, now: number = Date.now()) {
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: maxAge(expiresAt, now) };
}

/** A grant as the backend sent it, or undefined for anything else. */
export function grantOf(value: unknown): TrustedDeviceGrant | undefined {
  const g = value as Partial<TrustedDeviceGrant> | null | undefined;
  if (!g || typeof g.token !== "string" || typeof g.id !== "string" || typeof g.expiresAt !== "string") return undefined;
  return { token: g.token, id: g.id, expiresAt: g.expiresAt };
}
