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

/** The relay of last resort: a box inside Iran, reached by IPv4 address
 * with no SNI, whose certificate is accepted by SPKI pin alone
 * (src-tauri/src/relay_http.rs).
 *
 * Its own kind in the signed list (`kind: "lastResort"`), and kept here
 * in a list of its own, `EndpointBundle.lastResort`, never among
 * `endpoints`. That separation is the safety property: everything that
 * sends a normal request -- the race, the walks, `apiEndpoints()`, the
 * remembered address, the updater, the probes, the egress check, the
 * build-time HTTP scope -- reads `endpoints` and nothing else, and a
 * client from before this kind existed drops the entry as unknown. Only
 * last-resort.ts reads this list, and only through the Rust command. */
export interface LastResortEntry {
  /** `https://<dotted IPv4>[:port]/api`, exactly. */
  url: string;
  /** One to three `sha256/<base64>` SPKI pins: the box's key and a
   * standby. */
  pins: string[];
  /** ISO 3166-1 alpha-2, lowercase. Informational. */
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
  /** The relay entries, apart from `endpoints` (see `LastResortEntry`).
   * Absent where the bundle was not read by `verifyBundle`. */
  lastResort?: LastResortEntry[];
}

/** Envelope as published. The payload is carried as bytes rather than as
 * nested JSON so that verification never depends on re-serialising it
 * the same way the signer did -- canonicalisation bugs are a classic way
 * for a signature check to become decorative. */
interface SignedEnvelope {
  payload: string; // base64
  sig: string; // base64
  key: string; // which public key signed it: a compiled-in one, or `cert`'s
  /** Present when `key` is a server key rather than a compiled-in one:
   * the compiled-in key's signed statement that `key` may sign lists, and
   * until when (`ServerKeyStatement`). */
  cert?: { payload: string; sig: string; key: string };
}

/** What a compiled-in key signs to let a server key sign lists.
 *
 * The compiled-in keys live offline with the owner, so every list used to
 * wait for the owner to sign it by hand -- and a list that cannot be
 * published while the owner is away is a list that does not follow the
 * servers it describes. The server signs instead, under this statement:
 * one offline signature, renewed when it expires, rather than one per
 * change. A list it signs is otherwise held to every rule an offline one
 * is, so the worst a stolen server key can do is what a stolen list
 * could, and only until `expires`.
 *
 * Published as `/endpoints/bundle2` (bundle-store), apart from the
 * offline list: a client from before this existed knows no `cert` and
 * would refuse such a list, and must keep receiving the offline one. */
interface ServerKeyStatement {
  kind: "neoxify-bundle-key";
  /** The envelope's `key`. Never a compiled-in key's id. */
  id: string;
  /** The server's Ed25519 public key, 32 bytes, base64. */
  publicKey: string;
  /** Unix seconds after which lists signed with it are refused. */
  expires: number;
}

export const SERVER_KEY_STATEMENT_KIND = "neoxify-bundle-key";

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

/** A decimal number of one to `maxDigits` digits with no leading zero,
 * as relay_http.rs reads one (`decimal`). */
function decimal(text: string, maxDigits: number): number | null {
  if (text === "" || text.length > maxDigits || !/^[0-9]+$/.test(text)) return null;
  if (text.length > 1 && text.startsWith("0")) return null;
  return Number(text);
}

/** Why `url` cannot be a relay's base, or null. Read off the text rather
 * than through a URL parser, which accepts an address in octal, hex and
 * packed spellings and normalises them into a different server than the
 * text appears to name -- the same rule as `parse_base` in
 * relay_http.rs and `lastResortProblem` in the backend. */
function relayBaseProblem(url: unknown): string | null {
  if (typeof url !== "string") return "url must be a string";
  if (!url.startsWith("https://") || !url.endsWith("/api")) return "url must be https://<address>/api";
  const authority = url.slice("https://".length, -"/api".length);
  const [host, port, extra] = authority.split(":");
  if (extra !== undefined) return "url has more than one port";
  if (port !== undefined) {
    const value = decimal(port, 5);
    if (value === null || value === 0 || value > 65_535) return "port must be 1 to 65535";
  }
  const octets = host.split(".").map((part) => decimal(part, 3));
  if (octets.length !== 4 || octets.some((o) => o === null || o > 255)) return "host must be a dotted IPv4 address";
  const [a, b] = octets as number[];
  // "This network", loopback, link-local, multicast and broadcast cannot
  // be a relay on the internet.
  if (a === 0 || a === 127 || (a === 169 && b === 254) || (a >= 224 && a <= 239) || host === "255.255.255.255") {
    return "address cannot be a relay";
  }
  return null;
}

/** Why `pins` is not one to three distinct canonical SPKI pins, or null. */
function relayPinsProblem(pins: unknown): string | null {
  if (!Array.isArray(pins) || pins.length === 0 || pins.length > 3) return "pins must list one to three pins";
  const seen = new Set<string>();
  for (const pin of pins) {
    if (typeof pin !== "string" || !pin.startsWith("sha256/")) return "a pin must start with sha256/";
    const encoded = pin.slice("sha256/".length);
    if (encoded.length !== 44 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return "a pin must be 44 base64 characters";
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(encoded);
    } catch {
      return "a pin is not base64";
    }
    if (bytes.length !== 32) return "a pin must be a SHA-256 digest";
    // One spelling per digest: no stray trailing bits.
    let canonical = "";
    for (const byte of bytes) canonical += String.fromCharCode(byte);
    if (btoa(canonical) !== encoded) return "a pin is not canonical base64";
    if (seen.has(encoded)) return "a pin is listed twice";
    seen.add(encoded);
  }
  return null;
}

/** Why `value` is not a usable lastResort entry, or null. */
export function lastResortEntryProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "not an object";
  const e = value as Record<string, unknown>;
  if (e.kind !== "lastResort") return "not a lastResort entry";
  if (e.pin !== undefined) return "a lastResort entry takes pins, not pin";
  if (e.region !== undefined && typeof e.region !== "string") return "region must be a string";
  return relayBaseProblem(e.url) ?? relayPinsProblem(e.pins);
}

function lastResortEntry(value: unknown): LastResortEntry | null {
  if (lastResortEntryProblem(value) !== null) return null;
  const e = value as { url: string; pins: string[]; region?: string };
  return { url: e.url, pins: [...e.pins], ...(e.region !== undefined ? { region: e.region } : {}) };
}

/** Whether `keys` itself names `id` -- not an inherited property, which a
 * plain lookup would hand back for "constructor". */
function owns(keys: Readonly<Record<string, string>>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(keys, id);
}

/** The payload's bytes if `sig` is `key`'s signature over `payload`, all
 * base64; null for anything that does not decode, never a throw. */
async function signedBy(payload: string, sig: string, key: string): Promise<Uint8Array | null> {
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = fromBase64(payload);
    const ok = await verifyAsync(fromBase64(sig), payloadBytes, fromBase64(key));
    return ok ? payloadBytes : null;
  } catch {
    return null;
  }
}

/** The public key, base64, that signs `envelope`: a compiled-in one by
 * id, or a server key a compiled-in one vouches for (`ServerKeyStatement`)
 * that has not expired at `now`. Null if neither. */
async function envelopeSigner(
  envelope: SignedEnvelope,
  keys: Readonly<Record<string, string>>,
  now: number,
): Promise<string | null> {
  if (owns(keys, envelope.key)) return keys[envelope.key];
  const cert = envelope.cert;
  if (typeof cert !== "object" || cert === null) return null;
  if (typeof cert.payload !== "string" || typeof cert.sig !== "string" || typeof cert.key !== "string") return null;
  // Vouched for by a compiled-in key, and only by one: a statement signed
  // by another server key would let one leaked key mint the next.
  if (!owns(keys, cert.key)) return null;
  const statementBytes = await signedBy(cert.payload, cert.sig, keys[cert.key]);
  if (!statementBytes) return null;
  let statement: ServerKeyStatement;
  try {
    statement = JSON.parse(new TextDecoder().decode(statementBytes)) as ServerKeyStatement;
  } catch {
    return null;
  }
  if (statement?.kind !== SERVER_KEY_STATEMENT_KIND) return null;
  // The statement names the key the envelope says signed it, and that is
  // not a compiled-in key's id, which the first branch would have taken.
  if (statement.id !== envelope.key || owns(keys, statement.id)) return null;
  if (typeof statement.expires !== "number" || !Number.isFinite(statement.expires)) return null;
  if (now >= statement.expires * 1000) return null;
  if (typeof statement.publicKey !== "string") return null;
  try {
    if (fromBase64(statement.publicKey).length !== 32) return null;
  } catch {
    return null;
  }
  return statement.publicKey;
}

/** Verifies an envelope and returns the bundle, or null.
 *
 * Null for every failure, deliberately: the caller's only correct
 * response to a bad bundle is to keep the one it already trusts, and
 * distinguishing "forged" from "corrupt" would invite treating one of
 * them as recoverable.
 *
 * Signed by a compiled-in key, or by a server key one of them vouches for
 * until it expires (`ServerKeyStatement`); src-tauri/src/bundle_scope.rs
 * checks the same two ways before it widens the HTTP scope.
 */
export async function verifyBundle(
  raw: string,
  keys: Readonly<Record<string, string>> = BUNDLE_KEYS,
  now: number = Date.now(),
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

  const publicKey = await envelopeSigner(envelope, keys, now);
  if (!publicKey) return null;
  const payloadBytes = await signedBy(envelope.payload, envelope.sig, publicKey);
  if (!payloadBytes) return null;

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
  // looking like a successful update. A relay alone does not count: it
  // carries a few calls, under a budget, and only from Iran.
  if (endpoints.length === 0) return null;
  const lastResort = (bundle.endpoints as unknown[])
    .map(lastResortEntry)
    .filter((entry): entry is LastResortEntry => entry !== null);

  return { v: bundle.v, issuedAt: bundle.issuedAt, endpoints, lastResort };
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
