import { publicRace, type AnsweredBase, type RequestFailure } from "./api";
import type { EndpointTrace } from "./endpoint-trace";

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
 * At the difficulties issued to a source and an account with no recent
 * failures this finishes in milliseconds. It does not at the top of the
 * escalation range. A digest costs about nineteen microseconds in Node on
 * the Windows PC (measured on 2026-10-09), so the expected solve at 19 bits
 * is about ten seconds and at 21 bits about forty, on a desktop; a phone's
 * webview is likely slower, and neither webview has been measured. The
 * server asks for those after ten and twenty recent failures, forgotten
 * half an hour after the last one, per account and per source -- and
 * behind a node's mirror the source is the node, shared by every customer
 * on it. The sign-in's deadline does not count this time
 * (`SIGN_IN_DEADLINE_MS` in auth.ts).
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

/** What asking for a challenge found out. */
export interface ChallengeRace {
  /** The challenge, when a usable one came back. Unsolved: the solving is
   * the caller's, outside the time it allows the network
   * (`sendWithChallenge` in auth.ts). */
  challenge?: Challenge;
  /** Where to send the attempt: every address the backend itself
   * answered from, the one that handed out the challenge first, then any
   * that were over their throttle. See `Raced.answered`. Empty when only
   * pages from in front of the backend answered, or nothing did. */
  answered: AnsweredBase[];
  /** The addresses that answered only with a page. Not sent the attempt:
   * the backend was not reached through them. */
  pages: string[];
  /** The addresses that gave no answer at all. */
  failed: string[];
  /** The race's own result, when it was not a challenge: what the sign-in
   * says if nothing better comes of it -- "could not reach Neoxify" when
   * nothing answered, a page's status when only a page did. */
  failure?: RequestFailure;
}

/**
 * Fetches a challenge as a race across the endpoints.
 *
 * Raced rather than walked. Walked, it was the first of two walks over
 * the same list -- this one, then the sign-in itself -- each giving
 * every blocked address eight seconds. Against a simulated network with
 * the real eleven-address list, a sign-in with every address blackholed
 * took about three minutes to fail, and one with only the last address
 * alive eighty seconds to succeed. The challenge is minted and signed
 * without the server keeping any record of it, so it can safely be asked
 * of more than one address (`publicRace`). The race also answers the
 * question the sign-in would otherwise spend its own walk on: which
 * addresses answer on this network.
 *
 * The solution is still best-effort (`solveQuietly`). If a challenge does
 * not come back -- refused, throttled, unreadable -- the attempt goes
 * ahead without one and is judged on its merits, rather than making an
 * anti-abuse measure into one more thing that can lock a customer out of
 * their own account. The server refuses the attempt if it genuinely
 * requires a solution. Only when the backend answered nowhere is there no
 * attempt to make.
 *
 * `endpoints` limits the race to those addresses: a second race, over the
 * addresses the first did not hear from, when the attempt got no answer
 * where the first was answered.
 */
export async function raceChallengeFor(
  scope: LoginScope,
  email: string | undefined,
  trace?: EndpointTrace,
  signal?: AbortSignal,
  endpoints?: string[],
): Promise<ChallengeRace> {
  const { result, answered, pages, failed } = await publicRace<Challenge>(
    "/login-challenge",
    { method: "POST", body: JSON.stringify({ scope, email }), signal },
    trace,
    endpoints,
  );
  if (!result.ok) return { answered, pages, failed, failure: result };
  return { challenge: result.data, answered, pages, failed };
}

/** `solve`, or undefined when the challenge cannot be solved: the attempt
 * then goes without a solution, as above. */
export async function solveQuietly(challenge: Challenge | undefined): Promise<Solution | undefined> {
  if (challenge === undefined) return undefined;
  try {
    return await solve(challenge);
  } catch {
    return undefined;
  }
}
