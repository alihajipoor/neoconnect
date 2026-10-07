import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { verifyAppleTransaction, verifyChain } from "./apple-iap.provider";

/** Verifying a StoreKit purchase.
 *
 * The string under test arrives from a customer's phone, so every case
 * here is an attack rather than a mishap. A forged transaction is worth
 * a free subscription, which makes this the one file in the billing
 * module where a passing test that proves nothing is actively
 * dangerous.
 *
 * The fixture is the point. It is not a corrupted token or a random
 * string -- it is a complete, internally consistent JWS: a real ES256
 * signature over a real payload, by a real leaf certificate, issued by
 * a real intermediate, issued by a real root. Every signature in it
 * verifies. The only thing wrong with it is that the root is not
 * Apple's. That is exactly the token an attacker produces, and every
 * check except the pin accepts it.
 */

const BUNDLE_ID = "com.neoxify.mobile";
const rogue = readFileSync(join(__dirname, "apple-iap.rogue-fixture.txt"), "utf8").trim();

/** Apple's published fingerprint for Apple Root CA - G3.
 * https://www.apple.com/certificateauthority/ */
const APPLE_ROOT_SHA256 =
  "63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179";

describe("verifyAppleTransaction", () => {
  it("pins the real Apple root certificate", () => {
    // The load-bearing test. If the embedded certificate is ever
    // swapped -- by a bad merge, a careless copy-paste, or someone
    // "updating" it from an untrusted source -- every other test in
    // this file still passes and the verifier trusts an attacker's
    // root. Nothing else would notice.
    const source = readFileSync(join(__dirname, "apple-iap.provider.ts"), "utf8");
    const pem = source.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
    expect(pem).not.toBeNull();

    const der = Buffer.from(
      pem![0].replace(/-----[^-]+-----/g, "").replace(/\s/g, ""),
      "base64",
    );
    expect(createHash("sha256").update(der).digest("hex").toUpperCase()).toBe(APPLE_ROOT_SHA256);
  });

  it("refuses a perfectly valid chain that is not Apple's", () => {
    // Every signature in this token verifies. Accepting it would mean
    // anyone who can run openssl gets free subscriptions.
    expect(() => verifyAppleTransaction(rogue, BUNDLE_ID)).toThrow(
      /not anchored in Apple's root/,
    );
  });

  it("refuses a token with no certificate chain at all", () => {
    const header = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ bundleId: BUNDLE_ID })).toString("base64url");
    expect(() => verifyAppleTransaction(`${header}.${payload}.x`, BUNDLE_ID)).toThrow(
      /no certificate chain/,
    );
  });

  it("refuses an algorithm the token chose for itself", () => {
    // The classic JWT break: "none" skips verification entirely, and
    // HS256 turns the public certificate into a shared secret the
    // attacker also holds.
    for (const alg of ["none", "HS256", "RS256"]) {
      const header = Buffer.from(JSON.stringify({ alg, x5c: ["x"] })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({})).toString("base64url");
      expect(() => verifyAppleTransaction(`${header}.${payload}.sig`, BUNDLE_ID)).toThrow(
        /unexpected signing algorithm/,
      );
    }
  });

  it("refuses anything that is not three dot-separated parts", () => {
    for (const bad of ["", "one.two", "a.b.c.d", "not-a-token"]) {
      expect(() => verifyAppleTransaction(bad, BUNDLE_ID)).toThrow(/malformed transaction/);
    }
  });

  it("checks the chain before it reads the payload", () => {
    // Order matters: the payload is attacker-controlled JSON, and
    // nothing in it should be believed -- or acted on -- before the
    // signature says it came from Apple. A verifier that trusted
    // productId first would be exploitable regardless of the pin.
    expect(() => verifyAppleTransaction(rogue, "com.someone.else")).toThrow(
      /not anchored in Apple's root/,
    );
  });
});

/** The chain checks a pinned root does not make on its own.
 *
 * Apple Root CA - G3 is Apple's general ECC root. Under it, through a
 * WWDR intermediate, sit certificates any paid developer can get for a
 * key they generated -- an Apple Pay payment-processing certificate is
 * one. [that certificate, its intermediate, the root] has every signature
 * right and the root byte for byte, and the leaf's key is the attacker's.
 * Before these checks it was accepted, and every transactionId the
 * attacker made up was a paid subscription.
 *
 * Tested against a root of our own (apple-iap.chain-fixtures.json),
 * because the property is the shape of the chain under the root and
 * Apple's root's key is not ours to sign with. The chains are otherwise
 * Apple-shaped: an intermediate CA marked 6.2.1, a leaf marked 6.11.1.
 */
describe("verifyChain", () => {
  const f = JSON.parse(readFileSync(join(__dirname, "apple-iap.chain-fixtures.json"), "utf8")) as Record<
    string,
    string
  >;
  const rootPem = `-----BEGIN CERTIFICATE-----\n${f.root}\n-----END CERTIFICATE-----`;

  it("accepts a StoreKit-shaped chain: marked leaf, marked intermediate CA, the pinned root", () => {
    // The control. Without it every refusal below could be the chain
    // failing for some reason nobody intended.
    const leaf = verifyChain([f.leaf, f.intermediate, f.root], rootPem);
    expect(leaf.subject).toContain("Test StoreKit Leaf");
  });

  it("refuses a leaf without Apple's StoreKit-signer marker -- the Apple Pay route", () => {
    expect(() => verifyChain([f.leafWithoutMarker, f.intermediate, f.root], rootPem)).toThrow(
      /not Apple's StoreKit signer/,
    );
  });

  it("refuses an intermediate without Apple's WWDR marker", () => {
    expect(() => verifyChain([f.leafUnderUnmarkedIntermediate, f.intermediateWithoutMarker, f.root], rootPem)).toThrow(
      /not Apple's WWDR intermediate/,
    );
  });

  it("refuses a leaf used as an issuer", () => {
    // A certificate the attacker holds the key to, used to sign one more
    // "leaf" carrying whatever extensions they like.
    expect(() => verifyChain([f.leafSignedByLeaf, f.leaf, f.root], rootPem)).toThrow(/roles in the chain are wrong/);
  });

  it("refuses a chain that is not exactly leaf, intermediate, root", () => {
    expect(() => verifyChain([f.intermediate, f.root], rootPem)).toThrow(/chain length 2/);
    expect(() => verifyChain([f.leafSignedByLeaf, f.leaf, f.intermediate, f.root], rootPem)).toThrow(
      /chain length 4/,
    );
  });

  it("refuses a link whose issuer is not the certificate after it", () => {
    // The leaf was issued by the marked intermediate, not the unmarked
    // one; both are CAs under the same root.
    expect(() => verifyChain([f.leaf, f.intermediateWithoutMarker, f.root], rootPem)).toThrow(
      /not signed by its issuer/,
    );
  });

  it("still refuses all of it against Apple's real root", () => {
    expect(() => verifyChain([f.leaf, f.intermediate, f.root])).toThrow(/not anchored in Apple's root/);
  });
});
