import { randomBytes } from "node:crypto";

/// Characters a code is generated from.
///
/// No O/0, I/1 or similar: a voucher gets read off a screen, a sticker
/// or a chat message and typed by hand, and the pairs people confuse
/// are the ones that turn a working code into a support message.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;

/**
 * Extracted from VouchersService so the reseller programme mints codes
 * with the identical alphabet and length rather than its own copy.
 *
 * Two generators drifting apart would be a genuinely nasty bug: a
 * reseller code containing a character `normalise()` does not expect, or
 * of a different length, would look fine when generated and fail only
 * when a customer tried to redeem it -- with the reseller's token
 * already spent and the customer already paid.
 */
export function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Uppercased and stripped of the spacing and dashes people add when
 * reading a code aloud, so "abcd-efgh 1234" and "ABCDEFGH1234" are the
 * same voucher. */
export function normalise(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}
