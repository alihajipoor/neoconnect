import { X509Certificate, createPublicKey, verify as verifySignature } from "node:crypto";
import * as forge from "node-forge";

/** Checking that a StoreKit purchase really happened.
 *
 * StoreKit 2 hands the app a signed transaction (a JWS) and the app
 * sends it here. Everything below exists because that string arrives
 * from a device we do not control: on a jailbroken phone, or through a
 * proxy, it is whatever the attacker wants it to be. A free
 * subscription is worth forging, so this treats the transaction as a
 * claim until Apple's signature says otherwise.
 *
 * Verified locally rather than by calling Apple's servers. Both are
 * supported and Apple documents this one; it needs no second API
 * credential, it cannot be defeated by an outage, and it adds no
 * network round trip to a customer standing in a shop trying to buy
 * something. What it costs is that the chain has to be checked properly
 * here, which is what the rest of this file is.
 */

/** Apple Root CA - G3, the trust anchor for every StoreKit signature.
 *
 * Pinned rather than taken from the system trust store. The chain in
 * the token ends in a root the token itself supplies, so trusting that
 * root because it is self-consistent proves nothing whatsoever -- an
 * attacker generates their own root, signs their own chain with it, and
 * every signature in the token verifies perfectly. The only thing that
 * makes any of it evidence is that the root is *this* certificate.
 *
 * SHA-256 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:
 * 6F:30:17:B3:A8:C4:88:C3:65:3E:91:79, from
 * https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
 */
const APPLE_ROOT_CA_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

export interface VerifiedTransaction {
  /** This purchase. Unique per transaction, and what stops a replay. */
  transactionId: string;
  /** The first purchase in this chain. Equal to transactionId for a
   * non-renewing subscription bought once, and the thing that ties a
   * restore back to the original sale. */
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  /** "Sandbox" for a TestFlight or simulator purchase, which is real
   * enough to verify and must never be worth a real subscription in
   * production. The caller decides; this only reports. */
  environment: string;
  purchaseDate: Date;
}

function b64urlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Apple's marker on the certificate that signs App Store receipts and
 * StoreKit transactions -- the leaf. */
const STOREKIT_SIGNER_OID = "1.2.840.113635.100.6.11.1";
/** Apple's marker on the Worldwide Developer Relations intermediate that
 * issues it. */
const WWDR_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

/** The extension OIDs a certificate carries.
 *
 * Node's X509Certificate has no API for arbitrary extensions, so the DER
 * is walked with node-forge's ASN.1 reader (forge.pki itself cannot load
 * an EC certificate, but its parser reads any DER): tbsCertificate, then
 * its explicit [3] extensions, then each Extension's extnID. A substring
 * search of the raw bytes would also "find" an OID sitting in a subject
 * name or anywhere else an attacker can put bytes, which is why it is not
 * done that way. */
function extensionOids(cert: X509Certificate): Set<string> {
  const root = forge.asn1.fromDer(forge.util.createBuffer(cert.raw.toString("binary")));
  const tbs = (root.value as forge.asn1.Asn1[])[0];
  // [3] in the context-specific class: forge reports the tag number in
  // `type`, whose declared enum is the universal one, hence the Number().
  const wrapper = (tbs.value as forge.asn1.Asn1[]).find(
    (node) => node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && Number(node.type) === 3,
  );
  const oids = new Set<string>();
  if (!wrapper) return oids;
  const extensions = (wrapper.value as forge.asn1.Asn1[])[0];
  for (const extension of extensions.value as forge.asn1.Asn1[]) {
    const id = (extension.value as forge.asn1.Asn1[])[0];
    if (id?.type === forge.asn1.Type.OID && typeof id.value === "string") {
      oids.add(forge.asn1.derToOid(forge.util.createBuffer(id.value)));
    }
  }
  return oids;
}

/** Walks the certificate chain from the leaf up to the pinned root.
 *
 * Signatures and a pinned root are not enough on their own. Apple Root
 * CA - G3 is Apple's general ECC root, not a StoreKit-only one: under it
 * sit certificates any paid developer can get for a key they generated
 * themselves -- an Apple Pay payment-processing certificate, issued by a
 * WWDR intermediate, is one. A chain [that certificate, its intermediate,
 * the root] has every signature right and the root byte for byte, and the
 * leaf's key is the attacker's, so the token signature verifies too. Every
 * transactionId they invented would have been a paid subscription. Apple's
 * own verifiers refuse it, and so does this, the same way:
 *
 * * exactly three certificates: leaf, intermediate, root;
 * * the intermediate is a CA and the leaf is not, so a leaf cannot be
 *   used to sign a further "leaf" of the attacker's choosing;
 * * each certificate names the next as its issuer and is signed by it;
 * * every one is inside its validity window;
 * * the root is Apple's -- compared by raw bytes, because a certificate
 *   that merely *claims* the same subject is trivial to produce;
 * * the leaf carries Apple's StoreKit-signer marker and the intermediate
 *   the WWDR marker. This is the check that stops the Apple Pay route:
 *   a WWDR intermediate legitimately carries its marker, so the leaf's is
 *   what proves the key belongs to Apple's StoreKit signer.
 *
 * `anchorPem` exists for the tests, which need a root whose private key
 * they control to build chains that are otherwise exactly Apple-shaped.
 * Production code never passes it.
 */
export function verifyChain(x5c: string[], anchorPem: string = APPLE_ROOT_CA_G3): X509Certificate {
  if (x5c.length !== 3) throw new Error(`unexpected certificate chain length ${x5c.length}`);

  const chain = x5c.map((der) => new X509Certificate(Buffer.from(der, "base64")));
  const [leaf, intermediate, supplied] = chain;
  const root = new X509Certificate(anchorPem);

  const now = Date.now();
  for (const cert of chain) {
    if (new Date(cert.validFrom).getTime() > now || new Date(cert.validTo).getTime() < now) {
      throw new Error("a certificate in the chain is outside its validity window");
    }
  }

  // The chain's own last entry must BE Apple's root, byte for byte.
  if (!supplied.raw.equals(root.raw)) {
    throw new Error("chain is not anchored in Apple's root certificate");
  }

  if (!intermediate.ca || leaf.ca) {
    throw new Error("certificate roles in the chain are wrong");
  }

  // Each link names the next as its issuer and is signed by it.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) {
      throw new Error("a certificate in the chain was not signed by its issuer");
    }
  }

  if (!extensionOids(leaf).has(STOREKIT_SIGNER_OID)) {
    throw new Error("leaf certificate is not Apple's StoreKit signer");
  }
  if (!extensionOids(intermediate).has(WWDR_INTERMEDIATE_OID)) {
    throw new Error("intermediate certificate is not Apple's WWDR intermediate");
  }

  return leaf;
}

/** Verifies a StoreKit 2 signed transaction and returns what it says.
 *
 * Throws on anything at all suspicious. The caller turns that into a
 * refusal; nothing here should ever reach a customer, because every
 * message describes a forgery rather than something they can fix.
 */
export function verifyAppleTransaction(jws: string, expectedBundleId: string): VerifiedTransaction {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("malformed transaction");
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(b64urlToBuffer(headerB64).toString("utf8")) as {
    alg?: string;
    x5c?: string[];
  };
  // Pinned rather than read from the token. "alg" is attacker-supplied,
  // and the classic JWT break is accepting whatever it names -- "none"
  // most famously, but also swapping ES256 for HS256 so the public
  // certificate becomes the shared secret.
  if (header.alg !== "ES256") throw new Error(`unexpected signing algorithm ${header.alg}`);
  if (!Array.isArray(header.x5c) || header.x5c.length === 0) {
    throw new Error("transaction carries no certificate chain");
  }

  const leaf = verifyChain(header.x5c);

  const signed = Buffer.from(`${headerB64}.${payloadB64}`, "ascii");
  const ok = verifySignature(
    "sha256",
    signed,
    // ieee-p1363 because JWS carries the raw r||s pair, while Node
    // defaults to the DER encoding OpenSSL uses. Without this the
    // signature of a perfectly valid token fails to verify.
    { key: createPublicKey(leaf.publicKey), dsaEncoding: "ieee-p1363" },
    b64urlToBuffer(signatureB64),
  );
  if (!ok) throw new Error("transaction signature did not verify");

  const payload = JSON.parse(b64urlToBuffer(payloadB64).toString("utf8")) as Record<string, unknown>;

  const str = (key: string): string => {
    const value = payload[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`transaction has no ${key}`);
    }
    return value;
  };

  // Our app, not somebody else's. Without this, a signed transaction
  // from any App Store app at all would be accepted -- Apple signs them
  // all with the same chain, so the signature alone says only "a
  // purchase happened somewhere", which is not a statement about us.
  const bundleId = str("bundleId");
  if (bundleId !== expectedBundleId) {
    throw new Error("transaction belongs to a different application");
  }

  const purchaseDateMs = Number(payload.purchaseDate ?? 0);
  if (!Number.isFinite(purchaseDateMs) || purchaseDateMs <= 0) {
    throw new Error("transaction has no purchase date");
  }

  // A refunded or revoked purchase must not grant anything. Apple sets
  // this when it takes the money back, and a client replaying an old
  // token is exactly how someone would try to keep the subscription.
  if (payload.revocationDate !== undefined && payload.revocationDate !== null) {
    throw new Error("transaction has been revoked");
  }

  return {
    transactionId: str("transactionId"),
    originalTransactionId: str("originalTransactionId"),
    productId: str("productId"),
    bundleId,
    environment: typeof payload.environment === "string" ? payload.environment : "Production",
    purchaseDate: new Date(purchaseDateMs),
  };
}
