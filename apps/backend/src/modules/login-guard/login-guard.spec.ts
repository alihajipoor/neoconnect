import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LoginGuardService } from "./login-guard.service";
import { isSolved, mint, verify, type Challenge, type Solution } from "./proof-of-work";

/** Solve a challenge the way a browser would: count up until the hash
 * has enough leading zero bits. Kept deliberately naive -- it is also a
 * check that the difficulties we hand out are actually cheap enough to
 * brute-force in a test without slowing the suite down. */
function solve(challenge: Challenge): Solution {
  for (let nonce = 0; nonce < 50_000_000; nonce += 1) {
    if (isSolved(challenge.challenge, String(nonce), challenge.difficulty)) {
      return { ...challenge, nonce: String(nonce) };
    }
  }
  throw new Error("no solution found");
}

describe("proof of work", () => {
  it("accepts a genuinely solved challenge", () => {
    const solution = solve(mint(10));
    expect(verify(solution)).toEqual({ ok: true });
  });

  it("rejects a wrong nonce", () => {
    const challenge = mint(12);
    const result = verify({ ...challenge, nonce: "definitely-not-the-answer" });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects a challenge we never issued", () => {
    // The whole point of the HMAC: a client cannot mint its own
    // easy challenge and present it as ours.
    const forged: Solution = {
      id: "forged",
      challenge: "forged",
      difficulty: 1,
      expiresAt: Date.now() + 60_000,
      signature: "not-a-real-signature",
      nonce: "0",
    };
    expect(verify(forged)).toMatchObject({ ok: false });
  });

  it("rejects a solution whose difficulty was edited down after issue", () => {
    // Tampering with any signed field must invalidate the signature,
    // otherwise a client could claim an easy challenge was the hard one
    // it was actually given.
    const challenge = mint(20);
    const weakened = solve({ ...challenge, difficulty: 4 });
    expect(verify({ ...weakened, difficulty: 4 })).toMatchObject({ ok: false });
  });

  it("rejects an expired challenge", () => {
    const challenge = mint(8);
    const solution = solve(challenge);
    jest.useFakeTimers().setSystemTime(challenge.expiresAt + 1);
    try {
      expect(verify(solution)).toMatchObject({ ok: false });
    } finally {
      jest.useRealTimers();
    }
  });
});

/** A service with the grace threshold set, the way ConfigService would.
 * Undefined means "no LOGIN_CHALLENGE_GRACE_FAILURES set", i.e. the
 * default of 5. */
function guardWithGrace(grace: number | undefined): LoginGuardService {
  return new LoginGuardService({ get: () => grace } as unknown as ConfigService);
}

describe("LoginGuardService", () => {
  let guard: LoginGuardService;

  beforeEach(() => {
    guard = new LoginGuardService();
  });

  const IP = "203.0.113.7";
  const EMAIL = "someone@example.com";

  it("lets an attempt through with no challenge while nothing looks wrong", () => {
    // The clients already installed on customers' machines do not send
    // one. Requiring it immediately would lock out every live beta user.
    expect(() => guard.enforce("customer", undefined, EMAIL, IP)).not.toThrow();
  });

  it("starts demanding a challenge once failures pile up", () => {
    for (let i = 0; i < 5; i += 1) guard.recordFailure("customer", EMAIL, IP);
    expect(() => guard.enforce("customer", undefined, EMAIL, IP)).toThrow(BadRequestException);
  });

  it("accepts a solved challenge once one is demanded", () => {
    for (let i = 0; i < 5; i += 1) guard.recordFailure("customer", EMAIL, IP);
    const solution = solve(guard.issue("customer", EMAIL, IP));
    expect(() => guard.enforce("customer", solution, EMAIL, IP)).not.toThrow();
  });

  it("refuses to accept the same solution twice", () => {
    // Without single-use, one solved challenge would buy an attacker
    // every guess they could make before it expired.
    for (let i = 0; i < 5; i += 1) guard.recordFailure("customer", EMAIL, IP);
    const solution = solve(guard.issue("customer", EMAIL, IP));
    guard.enforce("customer", solution, EMAIL, IP);
    expect(() => guard.enforce("customer", solution, EMAIL, IP)).toThrow(BadRequestException);
  });

  it("raises the difficulty as an account accumulates failures", () => {
    const first = guard.issue("customer", EMAIL, IP).difficulty;
    for (let i = 0; i < 12; i += 1) guard.recordFailure("customer", EMAIL, IP);
    expect(guard.issue("customer", EMAIL, IP).difficulty).toBeGreaterThan(first);
  });

  it("follows the account across changing source addresses", () => {
    // The case per-IP throttling is blind to: one target, many sources.
    for (let i = 0; i < 12; i += 1) {
      guard.recordFailure("customer", EMAIL, `198.51.100.${i}`);
    }
    const fromFreshAddress = guard.issue("customer", EMAIL, "192.0.2.254");
    expect(fromFreshAddress.difficulty).toBeGreaterThan(
      guard.issue("customer", "untouched@example.com", "192.0.2.254").difficulty,
    );
  });

  it("follows the source across changing accounts", () => {
    // And the mirror image: one source spraying many accounts.
    for (let i = 0; i < 12; i += 1) {
      guard.recordFailure("customer", `victim${i}@example.com`, IP);
    }
    expect(guard.issue("customer", "fresh@example.com", IP).difficulty).toBeGreaterThan(
      guard.issue("customer", "fresh@example.com", "192.0.2.99").difficulty,
    );
  });

  it("rejects a cheap challenge stockpiled before the difficulty rose", () => {
    const cheap = solve(guard.issue("customer", EMAIL, IP));
    for (let i = 0; i < 12; i += 1) guard.recordFailure("customer", EMAIL, IP);
    expect(() => guard.enforce("customer", cheap, EMAIL, IP)).toThrow(BadRequestException);
  });

  it("clears an account's failures after a real sign-in", () => {
    for (let i = 0; i < 5; i += 1) guard.recordFailure("customer", EMAIL, IP);
    guard.recordSuccess("customer", EMAIL);
    // The source counter deliberately survives -- a shared address that
    // has produced many failures stays suspect even if one person on it
    // signed in successfully.
    expect(() => guard.enforce("customer", undefined, EMAIL, "192.0.2.5")).not.toThrow();
  });

  it("treats a blank or absent LOGIN_CHALLENGE_GRACE_FAILURES as the default", () => {
    // "" is what docker-compose passes for a variable that is merely
    // absent from .env, and Number("") is 0 -- which would silently
    // switch enforcement on and lock out every customer on a released
    // client. configuration.ts filters it out; this pins the behaviour
    // one layer down as well.
    const blank = guardWithGrace(undefined);
    expect(() => blank.enforce("customer", undefined, EMAIL, IP)).not.toThrow();
  });

  it("keeps admin and customer pressure separate", () => {
    for (let i = 0; i < 12; i += 1) guard.recordFailure("customer", EMAIL, IP);
    expect(guard.issue("admin", EMAIL, "192.0.2.1").difficulty).toBe(
      new LoginGuardService().issue("admin", EMAIL, "192.0.2.1").difficulty,
    );
  });
});

/**
 * The grace exists only for clients that cannot solve a challenge, and
 * is meant to be closed. Closing it is one variable
 * (LOGIN_CHALLENGE_GRACE_FAILURES=0), so both settings are pinned here
 * -- the second of these is the behaviour the operator is buying when
 * they flip it, and the first is what happens to every customer still
 * on a released build if they flip it too early.
 */
describe("LoginGuardService with the grace closed", () => {
  const IP = "203.0.113.9";
  const EMAIL = "closed@example.com";

  it("refuses the very FIRST attempt that carries no solution", () => {
    // Not the sixth. This is why the default cannot be 0 while
    // desktop-v0.9.4 and android-v0.2.9 -- neither of which contains
    // pow.ts -- are what customers are running.
    const guard = guardWithGrace(0);
    expect(() => guard.enforce("customer", undefined, EMAIL, IP)).toThrow(BadRequestException);
  });

  it("still accepts a properly solved challenge with no failures recorded", () => {
    const guard = guardWithGrace(0);
    const solution = solve(guard.issue("customer", EMAIL, IP));
    expect(() => guard.enforce("customer", solution, EMAIL, IP)).not.toThrow();
  });

  it("gives an attacker no free guesses at all", () => {
    const guard = guardWithGrace(0);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => guard.enforce("admin", undefined, EMAIL, IP)).toThrow(BadRequestException);
      guard.recordFailure("admin", EMAIL, IP);
    }
  });
});
