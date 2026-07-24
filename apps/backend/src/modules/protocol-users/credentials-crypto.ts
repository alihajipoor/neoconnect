import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // NIST-recommended nonce size for GCM

function getKey(): Buffer {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set -- required to store/read ProtocolUser credentials");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 raw bytes, hex-encoded (64 hex characters)");
  }
  return key;
}

/** Envelope-encrypts a ProtocolUser's credentials for storage.
 * ProtocolUser.credentialsJson holds a self-contained
 * "iv:authTag:ciphertext" hex string, not plaintext JSON, despite the
 * column's name (kept for backward-compat with the existing schema --
 * it's just a String column either way, no migration needed to switch
 * what it holds). Each call uses a fresh random IV, so encrypting the
 * same credentials twice produces different ciphertext. */
export function encryptCredentials(credentials: Record<string, string>): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
}

export function decryptCredentials(stored: string): Record<string, string> {
  const key = getKey();
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted credentials (expected iv:authTag:ciphertext)");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as Record<string, string>;
}
