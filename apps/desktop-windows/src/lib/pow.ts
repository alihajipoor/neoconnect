import { publicRequest } from "./api";

/** A challenge as the server issues it. Echoed back untouched. */
export interface Challenge {
  id: string;
  challenge: string;
  difficulty: number;
  expiresAt: number;
  signature: string;
}

export interface Solution extends Challenge {
  nonce: string;
}

/** Which login surface the challenge is for. */
export type LoginScope = "admin" | "customer" | "reseller";

/**
 * Solves the server's proof-of-work challenge before a sign-in or
 * registration attempt.
 *
 * The server tracks failures per ACCOUNT as well as per address, and
 * raises the required difficulty as they accumulate -- so a distributed
 * password-guessing attack pays more for every guess, while a customer
 * signing in normally solves a trivial one and never notices. Proof of
 * work rather than a CAPTCHA specifically because reCAPTCHA and
 * hCaptcha need to reach Google or Cloudflare, which is exactly what
 * cannot be relied on for customers in Iran.
 *
 * Shared by all three clients rather than written for the web portal
 * alone: the server currently waives the requirement below a handful of
 * recent failures purely so that already-installed builds keep working,
 * and that waiver is a real weakness that can only be removed once the
 * shipped clients solve challenges.
 */

/** Count leading zero bits, matching the server's check exactly. */
function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Search for a nonce satisfying the challenge.
 *
 * Yields to the event loop periodically so the page stays responsive.
 * At the difficulties actually issued this finishes in milliseconds;
 * the yield matters only at the top of the escalation range, where an
 * account under sustained attack can be asked for a second or two of
 * work and a frozen UI would look like a crash.
 */
export async function solve(challenge: Challenge): Promise<Solution> {
  const encoder = new TextEncoder();
  for (let nonce = 0; ; nonce += 1) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`${challenge.challenge}:${nonce}`),
    );
    if (leadingZeroBits(new Uint8Array(digest)) >= challenge.difficulty) {
      return { ...challenge, nonce: String(nonce) };
    }
    if (nonce % 2048 === 2047) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Guard against an absurd difficulty rather than spinning
      // forever. The server caps difficulty at 32 and issues at most
      // 21, so reaching this means something is wrong; giving up lets
      // the attempt proceed without a solution and get a clear answer
      // from the server instead of hanging here.
      if (nonce > 80_000_000) throw new Error("challenge too hard");
    }
  }
}

/**
 * Fetch and solve a challenge, or return undefined.
 *
 * Deliberately best-effort. If the challenge endpoint cannot be reached
 * -- which on a censored network is a real possibility -- returning
 * undefined lets the sign-in attempt go ahead and be judged on its
 * merits, rather than making an anti-abuse measure into one more thing
 * that can lock a customer out of their own account. The server refuses
 * the attempt if it genuinely requires a solution.
 */
export async function solveChallengeFor(
  scope: LoginScope,
  email?: string,
): Promise<Solution | undefined> {
  try {
    const result = await publicRequest<Challenge>("/login-challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, email }),
    });
    if (!result.ok) return undefined;
    return await solve(result.data);
  } catch {
    return undefined;
  }
}
