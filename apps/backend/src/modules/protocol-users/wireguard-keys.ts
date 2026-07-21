import { generateKeyPairSync } from "node:crypto";

// Fixed ASN.1 prefixes for a raw 32-byte X25519 key -- same technique as
// agent-gateway/ed25519.ts, confirmed by round-tripping a generated
// private key through the real `wg pubkey` and getting back the same
// public key this module derives (Node's x25519 keygen already does the
// RFC 7748 clamping WireGuard expects).
const X25519_PRIVATE_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_PUBLIC_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function generateWireGuardKeypair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519", {
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "der", type: "pkcs8" },
  });
  return {
    privateKey: privateKey.subarray(X25519_PRIVATE_PKCS8_PREFIX.length).toString("base64"),
    publicKey: publicKey.subarray(X25519_PUBLIC_SPKI_PREFIX.length).toString("base64"),
  };
}
