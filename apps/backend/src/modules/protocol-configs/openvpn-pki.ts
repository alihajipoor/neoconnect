import * as forge from "node-forge";

export interface CaBundle {
  caCertPem: string;
  caKeyPem: string;
}

export interface CertKeyPair {
  certPem: string;
  keyPem: string;
}

const RSA_BITS = 2048;
const CA_VALID_YEARS = 10;
const CERT_VALID_YEARS = 2;

/** Generates a self-signed CA -- once per OPENVPN ProtocolConfig, cached
 * in publicParamsJson by ProtocolConfigsService (see there for why the
 * CA private key is centralized in the backend rather than kept
 * node-local like WireGuard's server key: OpenVPN client provisioning
 * needs a signing step with no non-CA alternative, and centralizing it
 * keeps credential delivery synchronous like every other protocol). */
export function generateCa(commonName: string): CaBundle {
  const keys = forge.pki.rsa.generateKeyPair(RSA_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = addYears(new Date(), CA_VALID_YEARS);

  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    caCertPem: forge.pki.certificateToPem(cert),
    caKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** Signs a leaf certificate (server or client) with the given CA. */
export function signCert(ca: CaBundle, commonName: string, isServer: boolean): CertKeyPair {
  const caCert = forge.pki.certificateFromPem(ca.caCertPem);
  const caKey = forge.pki.privateKeyFromPem(ca.caKeyPem);

  const keys = forge.pki.rsa.generateKeyPair(RSA_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = addYears(new Date(), CERT_VALID_YEARS);

  cert.setSubject([{ name: "commonName", value: commonName }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    isServer
      ? { name: "extKeyUsage", serverAuth: true }
      : { name: "extKeyUsage", clientAuth: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function addYears(date: Date, years: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

function randomSerialHex(): string {
  // X.509 serials must be positive -- a leading 00 byte would make the
  // first hex digit's high bit read as a sign bit under DER's INTEGER
  // encoding, so prefix with "00" only when the first nibble is >= 8.
  const bytes = forge.random.getBytesSync(16);
  let hex = forge.util.bytesToHex(bytes);
  if (parseInt(hex[0], 16) >= 8) hex = "00" + hex;
  return hex;
}
