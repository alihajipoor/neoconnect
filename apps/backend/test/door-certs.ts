import { generateKeyPairSync, randomBytes } from "node:crypto";
import * as forge from "node-forge";

/** Certificates for the node-door specs, made as the tests run: a root
 * that stands in for a public CA, and leaves it did or did not sign.
 * Nothing here is a real key or a real name. */

export interface Authority {
  certPem: string;
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
}

export interface Leaf {
  keyPem: string;
  certPem: string;
}

const DAY_MS = 24 * 60 * 60_000;

function rsaKey() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = pair.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const publicPem = pair.publicKey.export({ type: "pkcs1", format: "pem" }) as string;
  return { keyPem, key: forge.pki.privateKeyFromPem(keyPem), publicKey: forge.pki.publicKeyFromPem(publicPem) };
}

function blank(publicKey: forge.pki.rsa.PublicKey, commonName: string, from: Date, to: Date) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  // Positive, as a serial number has to be.
  cert.serialNumber = "01" + randomBytes(8).toString("hex");
  cert.validity.notBefore = from;
  cert.validity.notAfter = to;
  cert.setSubject([{ name: "commonName", value: commonName }]);
  return cert;
}

/** A root certificate, to be passed to the prober as the roots it trusts. */
export function testRoot(commonName = "Door spec root"): Authority {
  const { key, publicKey } = rsaKey();
  const now = Date.now();
  const cert = blank(publicKey, commonName, new Date(now - DAY_MS), new Date(now + 30 * DAY_MS));
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(key, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), cert, key };
}

/** A server certificate naming `names`. Signed by `by`, or by its own key
 * when none is given. `commonName` is the subject only, never a
 * subjectAltName. */
export function leaf(options: {
  names: string[];
  by?: Authority;
  commonName?: string;
  notBefore?: Date;
  notAfter?: Date;
}): Leaf {
  const { keyPem, key, publicKey } = rsaKey();
  const now = Date.now();
  const cert = blank(
    publicKey,
    options.commonName ?? "door spec leaf",
    options.notBefore ?? new Date(now - DAY_MS),
    options.notAfter ?? new Date(now + 30 * DAY_MS),
  );
  cert.setIssuer((options.by?.cert ?? cert).subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    ...(options.names.length > 0
      ? [{ name: "subjectAltName", altNames: options.names.map((value) => ({ type: 2, value })) }]
      : []),
  ]);
  cert.sign(options.by?.key ?? key, forge.md.sha256.create());
  return { keyPem, certPem: forge.pki.certificateToPem(cert) };
}
