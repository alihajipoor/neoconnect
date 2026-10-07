/** A sign-in challenge as the backend issues it (POST /login-challenge).
 * Every field is echoed back untouched; `signature` is the backend's HMAC
 * over them. */
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

/** Hashes per batch. WebCrypto's digest is asynchronous, and awaiting one
 * at a time is mostly waiting: measured in Node 24 on this project's PC,
 * 53k hashes a second one by one against 244k in batches of 256. At the
 * top difficulty LoginGuard issues (21 bits, about two million hashes for
 * an account under sustained attack) that is ~9 s instead of ~40 s, and a
 * challenge expires two minutes after it is minted. */
const BATCH = 256;

/** Give up rather than spin. The backend issues at most 21 bits; a nonce
 * this far past that means something is wrong, and the attempt then goes
 * without a solution and gets a clear answer from the backend. */
const MAX_NONCE = 80_000_000;

/**
 * Find a nonce whose SHA-256 of `${challenge}:${nonce}` starts with at
 * least `difficulty` zero bits -- the backend's check in
 * apps/backend/src/modules/login-guard/proof-of-work.ts, and the same
 * search as the apps' apps/desktop-windows/src/lib/pow.ts.
 *
 * Runs in the operator's browser, never on the panel's server. Solving
 * server-side would make the panel a free solver for anyone posting its
 * login form, which is the cost the challenge exists to put on them.
 */
export async function solve(challenge: Challenge): Promise<Solution> {
  const encoder = new TextEncoder();
  for (let start = 0; start < MAX_NONCE; start += BATCH) {
    const digests = await Promise.all(
      Array.from({ length: BATCH }, (_, i) =>
        crypto.subtle.digest("SHA-256", encoder.encode(`${challenge.challenge}:${start + i}`)),
      ),
    );
    const hit = digests.findIndex((digest) => leadingZeroBits(new Uint8Array(digest)) >= challenge.difficulty);
    if (hit !== -1) return { ...challenge, nonce: String(start + hit) };
    // Let the page paint between batches.
    if (start % (BATCH * 16) === 0) await yieldToPage();
  }
  throw new Error("challenge too hard");
}

/** A turn of the event loop that is not a timer. Browsers throttle the
 * timers of a hidden tab (MDN: at least 1 s between them in Chrome and
 * Firefox), and at the top difficulty the search yields about 500 times:
 * with setTimeout, an operator who switched tabs while the check ran
 * could wait minutes on a challenge that expires in two. A posted
 * message is not a timer and is not held back that way. */
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

/** A solution as the login form posted it, reduced to exactly the fields
 * the backend's ChallengeSolutionDto declares -- its ValidationPipe
 * refuses any other property -- or undefined. Shape only: whether it is
 * genuine, unexpired and unspent is the backend's to decide. */
export function parseSolution(raw: unknown): Solution | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const strings = [v.id, v.challenge, v.signature, v.nonce];
  if (!strings.every((s) => typeof s === "string" && s.length > 0)) return undefined;
  if (!Number.isInteger(v.difficulty) || !Number.isInteger(v.expiresAt)) return undefined;
  return {
    id: v.id as string,
    challenge: v.challenge as string,
    difficulty: v.difficulty as number,
    expiresAt: v.expiresAt as number,
    signature: v.signature as string,
    nonce: v.nonce as string,
  };
}

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
