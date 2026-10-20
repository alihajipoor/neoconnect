import { createHash, createHmac } from "node:crypto";

/** What a signed-in device is called in GET /customer/devices, and what
 * DELETE /customer/devices/:id names: an opaque id derived from the
 * session, never the session id itself.
 *
 * The device-slot contract already holds to this -- "a session id is
 * never handed to another device" (docs/device-slots.md), which is why a
 * refusal names a holder by a handle. A device list is the same thing
 * shown to the same other devices, so it keeps the same rule.
 *
 * Keyed, so it cannot be computed from a session id without the server,
 * and scoped to the customer, so the same session can never be named
 * under another account. Stable for as long as the access-token secret
 * is: the list can be fetched, shown, and acted on a minute later. A
 * secret rotation only renames every device, and a stale id is a 404. */
export function deviceIdFor(secret: string, customerId: string, sessionId: string): string {
  const key = createHash("sha256").update(`neoxify-device-id\0${secret}`).digest();
  return createHmac("sha256", key).update(`${customerId}\0${sessionId}`).digest("base64url").slice(0, DEVICE_ID_LENGTH);
}

/** 132 bits: as unguessable as it needs to be, short enough to log. */
export const DEVICE_ID_LENGTH = 22;

export function isDeviceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value);
}
