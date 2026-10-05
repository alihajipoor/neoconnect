import { createHmac, timingSafeEqual } from "node:crypto";

/** A signed note saying "this caller was on network N at time T".
 *
 * # Why the client carries a token rather than its ASN
 *
 * Reports of how a connection went are usually sent *through* the tunnel
 * that just came up, so the address the server sees on them is the
 * node's, not the customer's. The only moment the server sees the
 * customer's own address is the pre-connect `/health/ip` call -- so that
 * is where the network is read, and the client has to carry it from
 * there to the report.
 *
 * Carrying a bare number would let anyone claim any network, and the
 * whole point of the per-ISP tags is that they describe what people on
 * that network actually experienced. So the server signs what it saw and
 * accepts back only its own signature: a client can choose not to send
 * it, and can send it late, but cannot invent one.
 *
 * It names a network and nothing else -- no address, no customer, no
 * device. Two customers on the same carrier in the same second receive
 * the same token, which is the intent: it is a fact about the network,
 * and nothing in it can be joined to a person.
 *
 * # Format
 *
 * `n1.<asn>.<issued unix seconds>.<mac>`, with the MAC an HMAC-SHA256
 * over the rest truncated to 128 bits. Short enough for a header,
 * versioned so the construction can change without a flag day.
 */

/** Domain separation from the base secret's other uses -- see
 * `exit-handle.ts`, which derives from the same configured secret under
 * its own label for the same reason. */
const PURPOSE = "neoxify:network-attestation:v1";
const VERSION = "n1";
const MAC_BYTES = 16;

/** How long an attestation is good for.
 *
 * A day. It has to outlive the session it describes -- the "kept
 * carrying traffic" report goes out ten minutes or more after the
 * baseline was taken, and a report queued offline may go out hours
 * later. Much longer and a laptop carried from home to a café would keep
 * reporting its home network's verdicts as the café's. */
export const ATTESTATION_TTL_SECONDS = 24 * 3600;

/** Small forward slack for a clock that disagrees with itself across
 * processes. */
const FUTURE_SLACK_SECONDS = 5 * 60;

export interface NetworkAttestor {
  /** Null when no secret is configured. */
  issue(asn: number, nowMs?: number): string | null;
  /** The ASN a token vouches for, or null for anything not issued here,
   * expired, malformed, or when no secret is configured. */
  verify(token: string | undefined | null, nowMs?: number): number | null;
}

export function networkAttestor(secret: string | undefined): NetworkAttestor {
  if (!secret) return { issue: () => null, verify: () => null };
  const key = createHmac("sha256", secret).update(PURPOSE).digest();
  const mac = (body: string) => createHmac("sha256", key).update(body).digest().subarray(0, MAC_BYTES);

  return {
    issue(asn, nowMs = Date.now()) {
      if (!Number.isInteger(asn) || asn <= 0) return null;
      const body = `${VERSION}.${asn}.${Math.floor(nowMs / 1000)}`;
      return `${body}.${mac(body).toString("base64url")}`;
    },
    verify(token, nowMs = Date.now()) {
      if (!token || token.length > 80) return null;
      const parts = token.split(".");
      if (parts.length !== 4 || parts[0] !== VERSION) return null;
      const [, asnText, issuedText, given] = parts;
      if (!/^\d{1,10}$/.test(asnText) || !/^\d{1,12}$/.test(issuedText)) return null;

      const expected = mac(`${VERSION}.${asnText}.${issuedText}`);
      const actual = Buffer.from(given, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

      const ageSeconds = Math.floor(nowMs / 1000) - Number(issuedText);
      if (ageSeconds > ATTESTATION_TTL_SECONDS || ageSeconds < -FUTURE_SLACK_SECONDS) return null;
      const asn = Number(asnText);
      return asn > 0 ? asn : null;
    },
  };
}
