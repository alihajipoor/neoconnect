import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { verifyAppleTransaction } from "./apple-iap.provider";

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
