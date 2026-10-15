import { relayContextOf } from "./relay-arrival";

/** The key a caller's sign-in failures and challenges are counted under.
 * Its address on the normal routes, as always. Over the relay, the keyed
 * hash of its address instead -- the address of a relay caller is never
 * put anywhere it could outlive the request or reach a log (I5), and the
 * login guard both keeps its key for half an hour and logs it. */
export function callerKey(req: unknown, ip: string): string {
  return relayContextOf(req)?.ipKey ?? ip;
}

/** The app's own install id, when it sent a sane one. Advisory only: it
 * is the client's say-so, so it is only ever used to make a sign-up
 * dearer, never cheaper (R3.5). */
export function installIdOf(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers["x-neoxify-install-id"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  return /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;
}
