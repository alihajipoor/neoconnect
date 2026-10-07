import { describe, expect, it, vi } from "vitest";
// The backend's own minting and checking, not a copy: a solution this
// solver finds must pass the code that will judge it.
import { mint, verify } from "../../../backend/src/modules/login-guard/proof-of-work";
import { parseSolution, solve } from "./pow";

describe("solve", () => {
  // 9 crosses a byte boundary; 12 is the floor LoginGuard issues. Not
  // higher: the work is random, and 15 bits ran past vitest's 5 s once on
  // a loaded CI runner -- the speed is not what this checks.
  it.each([1, 8, 9, 12])(
    "finds a nonce the backend accepts at %i bits",
    async (bits) => {
      const challenge = mint(bits);
      const solution = await solve(challenge);
      expect(verify(solution)).toEqual({ ok: true });
    },
    30_000,
  );

  // A hidden tab's timers are throttled; the far end of that is a timer
  // that does not fire. The search must not be waiting on one. This
  // challenge's first 12-bit nonce is 12155, past two of the solver's
  // pauses for the page.
  it("does not wait on timers, which a hidden tab throttles", async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] });
    try {
      const challenge = { id: "i", challenge: "throttled-tab-3", difficulty: 12, expiresAt: 1, signature: "s" };
      const stalled = new Promise<never>((_, reject) =>
        realSetTimeout(() => reject(new Error("the solver is waiting on a timer")), 10_000),
      );
      const solution = await Promise.race([solve(challenge), stalled]);
      expect(solution.nonce).toBe("12155");
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("changes nothing the backend signed", async () => {
    const challenge = mint(4);
    const { nonce, ...echoed } = await solve(challenge);
    expect(echoed).toEqual(challenge);
    expect(nonce).toMatch(/^\d+$/);
  });
});

describe("parseSolution", () => {
  it("keeps exactly the fields the backend's DTO declares", async () => {
    const solution = await solve(mint(4));
    const posted = JSON.stringify({ ...solution, extra: "x" });
    expect(parseSolution(posted)).toEqual(solution);
  });

  it("drops anything malformed", () => {
    expect(parseSolution(null)).toBeUndefined();
    expect(parseSolution("")).toBeUndefined();
    expect(parseSolution("{")).toBeUndefined();
    expect(parseSolution("[]")).toBeUndefined();
    const ok = { id: "a", challenge: "b", difficulty: 12, expiresAt: 1, signature: "s", nonce: "1" };
    expect(parseSolution(JSON.stringify(ok))).toEqual(ok);
    expect(parseSolution(JSON.stringify({ ...ok, difficulty: "12" }))).toBeUndefined();
    expect(parseSolution(JSON.stringify({ ...ok, nonce: 1 }))).toBeUndefined();
    expect(parseSolution(JSON.stringify({ ...ok, signature: "" }))).toBeUndefined();
  });
});
