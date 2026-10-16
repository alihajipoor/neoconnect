/** Which network this device was on the last time it could tell.
 *
 * The server reads it from the pre-connect `/health/ip` baseline -- the
 * one request in a connect whose source address is the customer's own,
 * since everything afterwards goes through the tunnel -- and answers
 * with the autonomous system (the carrier: "TCI", "Irancell") plus a
 * signed attestation of it. This file keeps that answer so it can ride
 * along with:
 *
 *  * attempt reports, which are usually sent through the tunnel and so
 *    arrive from the node's address, not ours;
 *  * route-list requests, so the server can say what other people on
 *    this network have recently got through on.
 *
 * It is a network, never a place: the backend sends no city and no
 * coordinates, and nothing here asks for them.
 *
 * Only ever set from a *baseline* reading. The after-connect reading
 * comes from the node, and the server deliberately omits the network
 * for its own addresses -- but this file does not rely on that alone.
 */

export interface NetworkReading {
  asn: number;
  /** The carrier's registered name, for display. May be empty. */
  org: string | null;
  /** Opaque, signed by the server, valid for about a day. Null from a
   * server that cannot sign (no secret configured). */
  attestation: string | null;
  /** When it was read, epoch ms. */
  at: number;
}

/** Comfortably inside the server's 24-hour validity, so an attestation
 * is dropped here before the server would refuse it. */
const MAX_AGE_MS = 23 * 3_600_000;

const STORAGE_KEY = "neoxify.network";

let current: NetworkReading | null = null;
let restored = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Restored lazily from the webview's storage, so a route list fetched
 * at launch -- before any baseline has been taken this run -- can still
 * be tagged. Per device and best-effort: a private window or cleared
 * storage just means no tags until the next baseline. */
function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as NetworkReading;
    if (typeof parsed?.asn === "number" && typeof parsed.at === "number") current = parsed;
  } catch {
    // Unreadable means unknown.
  }
}

/** Records what a baseline `/health/ip` answer said about the network.
 *
 * An answer *without* a network clears what was held rather than keeping
 * it. That answer came from somewhere the server could not or would not
 * place -- a node mirror answering the baseline, a table not loaded yet
 * -- and keeping the old value would attribute this connection to a
 * network the device may well have left. Unknown beats wrong. */
export function rememberNetwork(body: Record<string, unknown>, now = Date.now()): void {
  restored = true;
  current =
    typeof body.asn === "number" && Number.isInteger(body.asn) && body.asn > 0
      ? {
          asn: body.asn,
          org: typeof body.asnOrg === "string" ? body.asnOrg : null,
          attestation: typeof body.network === "string" ? body.network : null,
          at: now,
        }
      : null;
  try {
    const store = storage();
    if (current) store?.setItem(STORAGE_KEY, JSON.stringify(current));
    else store?.removeItem(STORAGE_KEY);
  } catch {
    // Persisting is a convenience; the in-memory value still stands.
  }
  if (current && typeof body.country === "string" && /^[A-Z]{2}$/.test(body.country)) {
    stampCountry(`asn:${current.asn}`, body.country, now);
  }
}

/** Where each network's answers were last stamped as coming from, by the
 * server's CDN (`country` on `/health/ip`), keyed as
 * `networkKeyFromAsn` keys them.
 *
 * The relay of last resort's evidence that a network is in Iran
 * (docs/relay-last-resort.md, R1.3; last-resort.ts). Only from a baseline
 * reading, as the network itself is: one taken through the tunnel would
 * stamp the exit's country on the customer's network. A baseline with no
 * country leaves the last stamp as it was rather than clearing it: the
 * network has not moved. Off the CDN -- a node mirror, or the origin
 * dialled directly -- the server fills in only "IR", from where the
 * network is registered, so those paths can add Iran evidence but never
 * stamp another country over it. */
const COUNTRY_KEY = "neoxify.network.country";
const MAX_STAMPS = 16;

function readStamps(): Record<string, { country: string; at: number }> {
  try {
    const raw = storage()?.getItem(COUNTRY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, { country: string; at: number }>) : {};
  } catch {
    return {};
  }
}

function stampCountry(key: string, country: string, now: number): void {
  try {
    const stamps = readStamps();
    stamps[key] = { country, at: now };
    const kept = Object.entries(stamps)
      .filter(([, stamp]) => typeof stamp?.country === "string" && typeof stamp.at === "number")
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_STAMPS);
    storage()?.setItem(COUNTRY_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Unknown is the answer until the next baseline.
  }
}

/** The country this network's answers were last stamped with, as an
 * upper-case ISO code, or null when none has been. */
export function stampedCountry(key: string | null): string | null {
  if (key === null) return null;
  const stamp = readStamps()[key];
  return typeof stamp?.country === "string" ? stamp.country : null;
}

/** The country of the latest stamp on any network, or null when nothing
 * was ever stamped on this install.
 *
 * For when this network cannot be named: `networkKeyFromAsn` forgets the
 * network a day after the last baseline, and with every route blocked no
 * baseline comes -- so it is unknown for as long as a blackout lasts. Where
 * the server last placed the device is still the best word there is on
 * where it is. */
export function latestStampedCountry(): string | null {
  let latest: { country: string; at: number } | null = null;
  for (const stamp of Object.values(readStamps())) {
    if (typeof stamp?.country !== "string" || typeof stamp.at !== "number") continue;
    if (latest === null || stamp.at > latest.at) latest = stamp;
  }
  return latest?.country ?? null;
}

/** The network as last read, if that was recent enough to still be
 * believed. */
export function currentNetwork(now = Date.now()): NetworkReading | null {
  restore();
  if (!current || now - current.at > MAX_AGE_MS) return null;
  return current;
}

/** The attestation to hand the server, if there is a usable one.
 *
 * Its presence is also how the rest of the client knows the backend is
 * new enough to accept the per-ISP fields: only a server that has them
 * issues one. See `attempts.ts`. */
export function currentAttestation(now = Date.now()): string | null {
  return currentNetwork(now)?.attestation ?? null;
}

/** Headers for a route-list request. Empty when there is nothing to say,
 * and the server then falls back to the request's own address. */
export function networkHeaders(now = Date.now()): Record<string, string> {
  const attestation = currentAttestation(now);
  return attestation ? { "X-Neoxify-Network": attestation } : {};
}

/** A key for "this network" in the per-network memories (`lastGood`,
 * `connect-history`), for a client with no better way to tell networks
 * apart.
 *
 * The Windows client fingerprints its gateway, which separates two Wi-Fi
 * networks on the same carrier. The mobile apps have no such command, and
 * the ASN is the next best thing: it separates mobile data from home
 * broadband, and different carriers from each other, which is most of
 * what makes one network filter differently from another. Two homes on
 * one ISP share a memory -- coarser than ideal, and still far better
 * than one bucket for everywhere. Null when unknown, which the memories
 * already treat as their shared "unknown" bucket. */
export function networkKeyFromAsn(now = Date.now()): string | null {
  const reading = currentNetwork(now);
  return reading ? `asn:${reading.asn}` : null;
}

/** For tests. */
export function resetNetworkForTests(): void {
  current = null;
  restored = false;
  try {
    storage()?.removeItem(COUNTRY_KEY);
  } catch {
    // Nothing held.
  }
}
