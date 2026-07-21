import { createPublicKey, verify as cryptoVerify } from "node:crypto";

// Fixed ASN.1 SPKI prefix for a raw 32-byte Ed25519 public key -- the
// standard, well-documented way to hand Node's crypto module a bare
// Ed25519 key without pulling in an extra dependency just for this.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyEd25519(rawPublicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (rawPublicKey.length !== 32) return false;
  try {
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
      format: "der",
      type: "spki",
    });
    // Ed25519 is "PureEdDSA" -- no separate digest algorithm, hence `null`.
    return cryptoVerify(null, message, keyObject, signature);
  } catch {
    return false;
  }
}
