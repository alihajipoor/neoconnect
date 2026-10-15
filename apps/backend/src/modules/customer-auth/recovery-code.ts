import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Recovery codes (docs/relay-last-resort.md, F7 and R4.3).
 *
 * The one way back into an account whose mailbox cannot be reached --
 * which, during a national intranet, is every mailbox abroad. Sixteen
 * base32 characters, 80 bits: too many to guess within the account's
 * shared guess budget, few enough to copy off a screen. Shown once, in
 * groups of four; stored only as a SHA-256, which is enough for a
 * random 80-bit secret (there is no dictionary to run against it).
 *
 * "Recovery code" (کد بازیابی) is this. The six-digit "reset code" (کد
 * بازنشانی) is the emailed one, and the two are never the same thing.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const RECOVERY_CODE_LENGTH = 16;

/** A fresh code, grouped for display: "ABCD-EFGH-JKLM-NPQR". */
export function newRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let code = "";
  // 256 is a multiple of 32, so taking the low five bits is unbiased.
  for (const byte of bytes) code += ALPHABET[byte & 31];
  return code.match(/.{4}/g)!.join("-");
}

/** The canonical form of what someone typed: upper case, no spaces or
 * dashes, and the letters people confuse with digits mapped back to the
 * ones base32 has (0 -> O, 1 -> I, 8 -> B). Null when it cannot be a code. */
export function normaliseRecoveryCode(input: string): string | null {
  const text = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/8/g, "B");
  if (text.length !== RECOVERY_CODE_LENGTH) return null;
  for (const ch of text) if (!ALPHABET.includes(ch)) return null;
  return text;
}

export function hashRecoveryCode(code: string): string {
  const normal = normaliseRecoveryCode(code);
  if (!normal) throw new Error("not a recovery code");
  return createHash("sha256").update(normal).digest("hex");
}

/** Whether `input` is the code `storedHash` was made from. Constant time
 * in the comparison; false for anything that is not a code at all. */
export function recoveryCodeMatches(input: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const normal = normaliseRecoveryCode(input);
  if (!normal) return false;
  const given = Buffer.from(createHash("sha256").update(normal).digest("hex"));
  const want = Buffer.from(storedHash);
  return given.length === want.length && timingSafeEqual(given, want);
}
