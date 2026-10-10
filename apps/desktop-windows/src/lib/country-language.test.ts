import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** The first-run language a customer's country suggests, and when it is
 * no longer worth waiting for.
 *
 * The question goes to the CDN, which knows the country. Reads now wait
 * up to twenty seconds an address, and this one with them, so on a
 * network where only the CDN answers, slowly, the answer came while the
 * customer was typing on the sign-in screen and switched the app under
 * their hands -- over a language they had just chosen, too. */

type Answer = ApiResult<{ ip: string; country?: string }>;
const ask = vi.fn<() => Promise<Answer>>();
vi.mock("./api", () => ({ publicRequest: () => ask(), apiRequest: vi.fn() }));

const { COUNTRY_BUDGET_MS, detectedLanguage, noteLanguageChosen, resetLanguageChoiceForTests } = await import("./i18n");

/** An answer from Iran, after `ms`. */
const fromIranAfter = (ms: number) =>
  new Promise<Answer>((resolve) => setTimeout(() => resolve({ ok: true, data: { ip: "192.0.2.1", country: "IR" } }), ms));

beforeEach(() => {
  vi.useFakeTimers();
  resetLanguageChoiceForTests();
  ask.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("the language a first run is shown in", () => {
  it("is Persian when the answer says Iran in time", async () => {
    ask.mockReturnValue(fromIranAfter(2_000));
    const detected = detectedLanguage();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await detected).toBe("fa");
  });

  /** Before: the answer at fifteen seconds was taken, and the app went
   * Persian and right-to-left while the customer was signing in. */
  it("is left alone when the answer comes after the budget", async () => {
    ask.mockReturnValue(fromIranAfter(15_000));
    const detected = detectedLanguage();
    await vi.advanceTimersByTimeAsync(COUNTRY_BUDGET_MS);
    expect(await detected).toBeUndefined();
    expect(COUNTRY_BUDGET_MS).toBe(8_000);
  });

  /** Before: a choice made while the question was out was overruled by
   * the answer, seconds after the customer made it. */
  it("is left alone when the customer chose one while it was asked", async () => {
    ask.mockReturnValue(fromIranAfter(3_000));
    const detected = detectedLanguage();
    await vi.advanceTimersByTimeAsync(1_000);
    noteLanguageChosen();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await detected).toBeUndefined();
  });

  it("is left alone when nothing answers", async () => {
    ask.mockResolvedValue({ ok: false, error: "Could not reach Neoxify. Check your internet connection.", noResponse: true });
    expect(await detectedLanguage()).toBeUndefined();
  });
});

/** Read from the source: the provider is the one place a choice is made. */
describe("a choice of language", () => {
  it("is noted where it is made", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./i18n.tsx", import.meta.url), "utf8");
    const setter = source.slice(source.indexOf("const setLanguage = useCallback("));
    expect(setter.indexOf("noteLanguageChosen();")).toBeGreaterThan(-1);
    expect(setter.indexOf("noteLanguageChosen();")).toBeLessThan(setter.indexOf("setLanguageState(next);"));
  });
});
