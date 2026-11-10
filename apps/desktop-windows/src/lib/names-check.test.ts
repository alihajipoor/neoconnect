import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The look at how the API's names resolve on this network, and what it
 * remembers (names-check.ts). The resolver is a fake here; the real one's
 * classes are names_check.rs's tests. */

let network: string | null = "asn:58224";
vi.mock("./network-identity", () => ({
  networkKeyFromAsn: () => network,
}));

const {
  namesBlockedHere,
  namesCheckAfterMs,
  namesFailHere,
  resetNamesCheckForTests,
  NAMES_CHECK_AFTER_MS,
  NAMES_CHECK_MS,
  NAMES_VERDICT_MS,
} = await import("./names-check");

const BASES = ["https://a.example/api", "https://b.example:2053/api", "https://b.example:8443/api"];

let now = 1_000_000;
let asked: string[][] = [];
let answer: (hosts: string[]) => unknown = () => [];

beforeEach(() => {
  network = "asn:58224";
  now = 1_000_000;
  asked = [];
  answer = (hosts) => hosts.map(() => "public");
  resetNamesCheckForTests({
    now: () => now,
    resolve: (hosts) => {
      asked.push(hosts);
      return Promise.resolve(answer(hosts));
    },
  });
});

describe("the look", () => {
  it("asks about each name once, and nothing but the name", async () => {
    await namesFailHere(BASES);
    expect(asked).toEqual([["a.example", "b.example"]]);
  });

  it("finds the names failing only when none of them resolves to a public address", async () => {
    answer = () => ["not-public", "no-answer"];
    expect(await namesFailHere(BASES)).toBe(true);
    answer = () => ["not-public", "not-public"];
    expect(await namesFailHere(BASES)).toBe(true);
    answer = () => ["not-public", "public"];
    expect(await namesFailHere(BASES)).toBe(false);
    answer = () => ["no-answer", "public"];
    expect(await namesFailHere(BASES)).toBe(false);
  });

  it("finds nothing in a resolver that has only not answered yet", async () => {
    // A weak signal, or a link still coming up: the names work there, a
    // little later. Silence counts only beside a name that did resolve,
    // to an address that is not public.
    answer = () => ["no-answer", "no-answer"];
    expect(await namesFailHere(BASES)).toBe(false);
    expect(namesBlockedHere()).toBe(false);
  });

  it("finds nothing when a name is one the resolver says nothing about", async () => {
    // Through a proxy, or an address literal: where its request goes is
    // not this machine's resolver's to say.
    answer = () => ["not-public", "unknown"];
    expect(await namesFailHere(BASES)).toBe(false);
  });

  it("finds nothing when the command has no answer to read", async () => {
    for (const reply of [null, undefined, [], ["not-public"], ["not-public", "blocked"], "not-public", { 0: "no-answer" }]) {
      answer = () => reply;
      expect(await namesFailHere(BASES)).toBe(false);
    }
    // A build without the command: the web portal, the macOS app.
    resetNamesCheckForTests({ resolve: () => Promise.reject(new Error("command names_resolve_public not found")) });
    expect(await namesFailHere(BASES)).toBe(false);
    resetNamesCheckForTests({
      resolve: () => {
        throw new TypeError("window.__TAURI_INTERNALS__ is undefined");
      },
    });
    expect(await namesFailHere(BASES)).toBe(false);
  });

  it("finds nothing, and asks nothing, about a list it cannot read", async () => {
    answer = (hosts) => hosts.map(() => "not-public");
    expect(await namesFailHere([])).toBe(false);
    expect(await namesFailHere(["https://a.example/api", "not a url"])).toBe(false);
    expect(await namesFailHere(Array.from({ length: 65 }, (_, i) => `https://n${i}.example/api`))).toBe(false);
    expect(asked).toEqual([]);
  });

  it("is shared by requests that start together, and made again by one that starts later", async () => {
    answer = (hosts) => hosts.map(() => "not-public");
    const [first, second] = await Promise.all([namesFailHere(BASES), namesFailHere(BASES)]);
    expect([first, second]).toEqual([true, true]);
    expect(asked).toHaveLength(1);
    await namesFailHere(BASES);
    expect(asked).toHaveLength(2);
  });

  it("gives up on a command that never returns, a little after the command's own cap", async () => {
    vi.useFakeTimers();
    try {
      resetNamesCheckForTests({ resolve: () => new Promise(() => undefined) });
      let found: boolean | null = null;
      void namesFailHere(BASES).then((value) => {
        found = value;
      });
      await vi.advanceTimersByTimeAsync(NAMES_CHECK_MS);
      expect(found).toBeNull();
      await vi.advanceTimersByTimeAsync(500);
      expect(found).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("namesBlockedHere", () => {
  it("is false until a look has found the names failing", async () => {
    expect(namesBlockedHere()).toBe(false);
    await namesFailHere(BASES);
    expect(namesBlockedHere()).toBe(false);
  });

  it("stands from a look that found them failing until one that does not", async () => {
    answer = (hosts) => hosts.map(() => "not-public");
    await namesFailHere(BASES);
    expect(namesBlockedHere()).toBe(true);
    now += 60_000;
    expect(namesBlockedHere()).toBe(true);
    answer = () => ["not-public", "public"];
    await namesFailHere(BASES);
    expect(namesBlockedHere()).toBe(false);
  });

  it("is left as it was by a look the command gave no answer to", async () => {
    answer = () => ["not-public", "no-answer"];
    await namesFailHere(BASES);
    answer = () => null;
    await namesFailHere(BASES);
    expect(namesBlockedHere()).toBe(true);
  });

  it("lapses fifteen minutes after the last look that found it, and is renewed by another", async () => {
    answer = (hosts) => hosts.map(() => "not-public");
    await namesFailHere(BASES);
    now += NAMES_VERDICT_MS - 1;
    expect(namesBlockedHere()).toBe(true);
    await namesFailHere(BASES);
    now += NAMES_VERDICT_MS - 1;
    expect(namesBlockedHere()).toBe(true);
    now += 1;
    expect(namesBlockedHere()).toBe(false);
  });

  it("is about the network the look was made on, and no other", async () => {
    answer = (hosts) => hosts.map(() => "not-public");
    await namesFailHere(BASES);
    network = "asn:197207";
    expect(namesBlockedHere()).toBe(false);
    network = null;
    expect(namesBlockedHere()).toBe(false);
    network = "asn:58224";
    expect(namesBlockedHere()).toBe(true);
  });
});

describe("the numbers", () => {
  it("hold the look's time to the command's own cap", () => {
    const rust = readFileSync(new URL("../../src-tauri/src/names_check.rs", import.meta.url), "utf8");
    const cap = /const NAMES_CHECK_CAP: Duration = Duration::from_millis\(([\d_]+)\);/.exec(rust);
    expect(cap).not.toBeNull();
    expect(Number(cap![1].replaceAll("_", ""))).toBe(NAMES_CHECK_MS);
    const most = /const MAX_NAMES: usize = (\d+);/.exec(rust);
    expect(most).not.toBeNull();
    // One more than the look takes is refused here, as the command would.
    expect(Number(most![1])).toBe(64);
  });

  it("leave a request alone for its first half second", () => {
    expect(NAMES_CHECK_AFTER_MS).toBe(500);
    expect(namesCheckAfterMs()).toBe(NAMES_CHECK_AFTER_MS);
    resetNamesCheckForTests({ afterMs: 5 });
    expect(namesCheckAfterMs()).toBe(5);
  });
});
