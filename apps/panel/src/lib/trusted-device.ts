import "server-only";
import { cookies } from "next/headers";
import {
  TRUSTED_COOKIE,
  TRUSTED_COOKIE_PATH,
  TRUSTED_ID_COOKIE,
  type TrustedDeviceGrant,
  trustedCookieOptions,
  trustedIdCookieOptions,
} from "./trusted-device-cookie";

const secure = () => process.env.NODE_ENV === "production";

/** The token this browser sent, on the /login path only. */
export async function readTrustedToken(): Promise<string | undefined> {
  return (await cookies()).get(TRUSTED_COOKIE)?.value || undefined;
}

/** This browser's trusted-device row, for marking "this device". */
export async function currentTrustedDeviceId(): Promise<string | undefined> {
  return (await cookies()).get(TRUSTED_ID_COOKIE)?.value || undefined;
}

/** Only from a Server Action or Route Handler. */
export async function setTrustedDevice(grant: TrustedDeviceGrant): Promise<void> {
  const store = await cookies();
  store.set(TRUSTED_COOKIE, grant.token, trustedCookieOptions(grant.expiresAt, secure()));
  store.set(TRUSTED_ID_COOKIE, grant.id, trustedIdCookieOptions(grant.expiresAt, secure()));
}

/** Only from a Server Action or Route Handler. Works from any page: the
 * secret's cookie is overwritten on its own path, expired. */
export async function clearTrustedDevice(): Promise<void> {
  const store = await cookies();
  const gone = new Date(0).toISOString();
  store.set(TRUSTED_COOKIE, "", { ...trustedCookieOptions(gone, secure()), path: TRUSTED_COOKIE_PATH });
  store.set(TRUSTED_ID_COOKIE, "", trustedIdCookieOptions(gone, secure()));
}
