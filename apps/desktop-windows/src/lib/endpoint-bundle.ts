import { verifyAsync } from "@noble/ed25519";

/** The signed list of places this client can reach Neoxify.
 *
 * # Why this exists
 *
 * The endpoints used to be compiled in. On 2026-09-01 Iran DNS-poisoned
 * and SNI-blocked the whole of the infrastructure domain, and all three
 * of them lived on it -- so the fallback list failed as one thing, and
 * the only fix was a release the censored customers could not download.
 *
 * A signed list breaks that: the addresses become data the operator can
 * replace, and a client that reaches *any* of them learns all the
 * others.
 *
 * # Why signing, rather than fetching over TLS from a trusted host
 *
 * Because a trusted host is a host that can be blocked, and then the
 * list cannot be updated at all -- which is the failure being fixed.
 * A signature moves the trust into the file, so the file can come from
 * anywhere: a mirror, a CDN, a gist, a message from support. None of
 * those need to be trusted, or even friendly.
 *
 * The public keys are compiled in. Nothing fetches a key, so there is no
 * key server to block, and a censor who serves a forged bundle produces
 * a signature failure rather than a redirect.
 */
export interface EndpointEntry {
  /** What this address can serve. `panel` is the control plane proper;
   * `mirror` is a VPN node that also answers /api on its TLS port. They
   * are interchangeable to the caller and separated only so the client
   * can prefer one kind on a given network -- an in-country mirror beats
   * a foreign panel when consumer links lose international reach, which
   * is the ordinary shape of an Iranian shutdown. */
  kind: "panel" | "mirror";
  /** Full base URL including scheme, host and any port. May be a
   * hostname or a bare IP: the two fail to different attacks, so the
   * bundle deliberately carries both rather than choosing. */
  url: string;
  /** `sha256/<base64>` of the server's SubjectPublicKeyInfo, for entries
   * addressed by IP where there is no name to validate. Absent on
   * hostname entries, which validate normally. */
  pin?: string;
  /** ISO 3166-1 alpha-2, lowercase. Ordering hint only. */
  region?: string;
}

export interface EndpointBundle {
  /** Monotonic. A bundle is only accepted if it is strictly newer than
   * the one already held, so a censor replaying a genuinely-signed older
   * list cannot walk a client back onto addresses that have since been
   * retired. */
  v: number;
  issuedAt: string;
  endpoints: EndpointEntry[];
}

/** Envelope as published. The payload is carried as bytes rather than as
 * nested JSON so that verification never depends on re-serialising it
 * the same way the signer did -- canonicalisation bugs are a classic way
 * for a signature check to become decorative. */
interface SignedEnvelope {
  payload: string; // base64
  sig: string; // base64
  key: string; // which compiled-in public key signed it
}

/** Compiled-in verification keys, by id.
 *
 * TWO of them, from the first release, and this cannot be added later to
 * clients already in the field. If the primary is ever lost or
 * compromised and a client only knows one key, the fix needs a new build
 * -- which is undeliverable to exactly the censored users who most need
 * it. The spare costs nothing today and is the only thing that makes key
 * rotation survivable.
 *
 * These are public halves and belong in the binary -- they are shipped to
 * every customer by definition. The private halves were generated offline
 * and are not in this repository, on the panel, or on any node. */
export const BUNDLE_KEYS: Readonly<Record<string, string>> = {
  primary: "I7JX0c+ynlt9n51qwQUVeqKAfN0kVJ5D4LFMxMr0n/g=",
  backup: "BJ3ROKfvxHbec/Zq7jGdUweQEUr2K6VspEPRlEveYsI=",
};

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function isEntry(value: unknown): value is EndpointEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  if (e.kind !== "panel" && e.kind !== "mirror") return false;
  if (typeof e.url !== "string" || e.url === "") return false;
  // Only https. An http entry in a signed bundle would be a downgrade a
  // censor could exploit even though the list itself is authentic.
  if (!e.url.startsWith("https://")) return false;
  if (e.pin !== undefined && typeof e.pin !== "string") return false;
  if (e.region !== undefined && typeof e.region !== "string") return false;
  return true;
}

/** Verifies an envelope and returns the bundle, or null.
 *
 * Null for every failure, deliberately: the caller's only correct
 * response to a bad bundle is to keep the one it already trusts, and
 * distinguishing "forged" from "corrupt" would invite treating one of
 * them as recoverable.
 */
export async function verifyBundle(
  raw: string,
  keys: Readonly<Record<string, string>> = BUNDLE_KEYS,
): Promise<EndpointBundle | null> {
  let envelope: SignedEnvelope;
  try {
    envelope = JSON.parse(raw) as SignedEnvelope;
  } catch {
    return null;
  }
  if (
    typeof envelope?.payload !== "string" ||
    typeof envelope?.sig !== "string" ||
    typeof envelope?.key !== "string"
  ) {
    return null;
  }

  const publicKey = keys[envelope.key];
  if (!publicKey) return null;

  let payloadBytes: Uint8Array;
  let signature: Uint8Array;
  let keyBytes: Uint8Array;
  try {
    payloadBytes = fromBase64(envelope.payload);
    signature = fromBase64(envelope.sig);
    keyBytes = fromBase64(publicKey);
  } catch {
    return null;
  }

  let ok = false;
  try {
    ok = await verifyAsync(signature, payloadBytes, keyBytes);
  } catch {
    return null;
  }
  if (!ok) return null;

  let bundle: EndpointBundle;
  try {
    bundle = JSON.parse(new TextDecoder().decode(payloadBytes)) as EndpointBundle;
  } catch {
    return null;
  }

  // A valid signature over a malformed list is still unusable, and the
  // shape is checked after the signature rather than before so that
  // nothing is parsed on an attacker's say-so.
  if (typeof bundle?.v !== "number" || !Number.isFinite(bundle.v)) return null;
  if (typeof bundle?.issuedAt !== "string") return null;
  if (!Array.isArray(bundle.endpoints)) return null;
  const endpoints = bundle.endpoints.filter(isEntry);
  // An empty list would leave the client with nowhere to go while
  // looking like a successful update.
  if (endpoints.length === 0) return null;

  return { v: bundle.v, issuedAt: bundle.issuedAt, endpoints };
}

/** Whether `candidate` should replace `held`.
 *
 * Strictly greater, never equal: re-publishing under the same version is
 * an operator mistake, and letting it through would make the version
 * number stop meaning anything.
 */
export function isNewer(candidate: EndpointBundle, held: EndpointBundle | null): boolean {
  return held === null || candidate.v > held.v;
}

/** Base URLs in the order to try.
 *
 * `preferRegion` puts in-country entries first. That is not a
 * nicety: when consumer links lose international reach but domestic
 * routing survives -- the ordinary shape of an Iranian shutdown, and the
 * reason the relay exists -- a mirror inside the country is the only
 * thing reachable, and trying three foreign addresses first spends the
 * customer's patience before getting there.
 */
export function orderedBases(bundle: EndpointBundle, preferRegion?: string): string[] {
  const scored = bundle.endpoints.map((e, i) => ({
    url: e.url,
    // Stable within a tier: the operator's order carries meaning.
    rank: (preferRegion && e.region === preferRegion ? 0 : 1) * 1000 + i,
  }));
  scored.sort((a, b) => a.rank - b.rank);
  return [...new Set(scored.map((s) => s.url))];
}
