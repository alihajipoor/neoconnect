import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A server-issued proof-of-work challenge, used to make credential
 * flooding cost the attacker real CPU time.
 *
 * WHY PROOF OF WORK AND NOT A CAPTCHA -- this is the load-bearing
 * decision here, not an implementation detail.
 *
 * reCAPTCHA and hCaptcha both require the visitor's browser to reach
 * Google/Cloudflare infrastructure. A large share of this product's
 * customers are in Iran, where that reachability is exactly what cannot
 * be relied on -- so a third-party CAPTCHA would fail closed for the
 * people the product exists for, and it would fail invisibly from our
 * side: the login page would simply never finish loading for them while
 * looking perfectly healthy to us. Locking out the core audience to
 * slow down bots is a bad trade, and an unobservable one is worse.
 *
 * Proof of work needs no third party, no external host, and no network
 * at all beyond the API call already being made. It is also honest
 * about what it does: it does not try to tell humans from machines
 * (which is what a CAPTCHA attempts and increasingly fails at), it just
 * puts a price on every attempt. A real customer signing in once pays
 * a few hundred milliseconds they will not notice. Someone trying
 * millions of passwords pays that same cost a million times.
 *
 * Challenges are stateless and HMAC-signed rather than stored: the
 * server can verify it minted a challenge, and minted it for this
 * scope and difficulty, without keeping a table of outstanding ones.
 * Only the single-use record needs storage, and only until it expires.
 */
export interface Challenge {
  /** Unique per issue; the single-use key on redemption. */
  id: string;
  /** The random string the client hashes against. */
  challenge: string;
  /** Required leading zero BITS in the resulting hash. */
  difficulty: number;
  /** Unix ms. Short, so an unused challenge cannot be stockpiled. */
  expiresAt: number;
  /** HMAC over every field above, proving the server issued this. */
  signature: string;
}

/** A solved challenge, as the client submits it back. */
export interface Solution extends Challenge {
  /** The value the client found. Any string; searched as an integer. */
  nonce: string;
}

/**
 * The signing key.
 *
 * Deliberately generated per process rather than read from config. A
 * restart invalidating outstanding challenges is harmless -- they live
 * two minutes and the client simply requests another -- and this avoids
 * adding a secret that would have to be threaded through
 * configuration.ts, .env.example, docker-compose.prod.yml and
 * generate_panel_secrets(). That plumbing has been missed before in
 * this repo (CREDENTIALS_ENCRYPTION_KEY never reached the deployed box),
 * and a secret that silently defaults on one host and not another is a
 * worse failure than a two-minute challenge lifetime.
 */
const SIGNING_KEY = randomBytes(32);

/** How long a minted challenge stays solvable. */
const TTL_MS = 2 * 60 * 1000;

function sign(fields: Omit<Challenge, "signature">): string {
  return createHmac("sha256", SIGNING_KEY)
    .update(`${fields.id}|${fields.challenge}|${fields.difficulty}|${fields.expiresAt}`)
    .digest("base64url");
}

/** Mint a challenge at the given difficulty in leading zero bits. */
export function mint(difficulty: number): Challenge {
  const fields = {
    id: randomBytes(12).toString("base64url"),
    challenge: randomBytes(16).toString("base64url"),
    difficulty,
    expiresAt: Date.now() + TTL_MS,
  };
  return { ...fields, signature: sign(fields) };
}

/**
 * Count leading zero bits of a digest.
 *
 * Bits rather than hex characters so difficulty can be tuned smoothly.
 * Each additional bit doubles the expected work; stepping a hex digit
 * at a time would quadruple it, which jumps from "unnoticeable" to
 * "the page appears frozen" in one step.
 */
function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** Whether a nonce actually solves a challenge. */
export function isSolved(challenge: string, nonce: string, difficulty: number): boolean {
  const digest = createHash("sha256").update(`${challenge}:${nonce}`).digest();
  return leadingZeroBits(digest) >= difficulty;
}

/**
 * Verify a submitted solution's authenticity and expiry.
 *
 * Does NOT enforce single use -- that needs state, and lives in the
 * service. Returns a reason rather than throwing so the caller decides
 * what to reveal.
 */
export function verify(solution: Solution): { ok: true } | { ok: false; reason: string } {
  const expected = sign({
    id: solution.id,
    challenge: solution.challenge,
    difficulty: solution.difficulty,
    expiresAt: solution.expiresAt,
  });

  // Compare via timingSafeEqual, and length-check first: it throws on
  // mismatched lengths rather than returning false.
  const provided = Buffer.from(String(solution.signature));
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    return { ok: false, reason: "This security check was not issued by us. Request a new one." };
  }

  if (Date.now() > solution.expiresAt) {
    return { ok: false, reason: "This security check expired. Please try again." };
  }

  if (!isSolved(solution.challenge, solution.nonce, solution.difficulty)) {
    return { ok: false, reason: "This security check was not completed correctly." };
  }

  return { ok: true };
}
