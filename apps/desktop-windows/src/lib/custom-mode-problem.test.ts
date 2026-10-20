import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { customModeProblemText, readCustomModeProblem } from "./custom-mode-problem";
import { DICTIONARIES, type TranslationKey } from "./i18n";
import { adoptedSince } from "./session-clock";

/** Custom mode's problem in the customer's language, from the service's
 * code (inventory B5), and the session timer for a tunnel found up at
 * launch, from the service's own age for it (B2). */

const en = (key: TranslationKey) => DICTIONARIES.en[key];
const fa = (key: TranslationKey) => DICTIONARIES.fa[key];
const SENTENCE = "Your chosen apps are being sent through the VPN but nothing is coming back.";

describe("Custom mode's problem", () => {
  it("is the service's report: nothing without its sentence, the code when it came", () => {
    expect(readCustomModeProblem({})).toBeNull();
    expect(readCustomModeProblem({ splitTunnelProblem: "  " })).toBeNull();
    // A code with no sentence is not a problem the service reported.
    expect(readCustomModeProblem({ splitTunnelProblemCode: "noReplies" })).toBeNull();
    expect(readCustomModeProblem({ splitTunnelProblem: SENTENCE })).toEqual({ code: null, sentence: SENTENCE });
    expect(readCustomModeProblem({ splitTunnelProblem: SENTENCE, splitTunnelProblemCode: "noReplies" })).toEqual({
      code: "noReplies",
      sentence: SENTENCE,
    });
  });

  it("is said in the app's own words, in both languages, for each code the service sends", () => {
    for (const code of ["injectionRefused", "noReplies", "noAppTraffic", "adapterGone"]) {
      const problem = { code, sentence: SENTENCE };
      const english = customModeProblemText(problem, en);
      const persian = customModeProblemText(problem, fa);
      expect(english, code).not.toBe(SENTENCE);
      expect(english, code).not.toMatch(/^dash\./);
      // Persian, not the English sentence handed through.
      expect(persian, code).toMatch(/[؀-ۿ]/);
      expect(persian, code).not.toBe(english);
    }
  });

  it("falls back to the service's sentence for a code it does not know, or none", () => {
    expect(customModeProblemText({ code: "other", sentence: SENTENCE }, fa)).toBe(SENTENCE);
    expect(customModeProblemText({ code: "toString", sentence: SENTENCE }, fa)).toBe(SENTENCE);
    expect(customModeProblemText({ code: null, sentence: SENTENCE }, en)).toBe(SENTENCE);
  });

  it("names the same problem as the service's sentence for each code", () => {
    // The Rust side (split_tunnel/intercept/stats.rs) pairs each code with
    // its sentence; the app's words must say the same thing.
    expect(en("dash.customProblemInjectionRefused")).toContain("refusing the redirected packets");
    expect(en("dash.customProblemNoReplies")).toContain("nothing is coming back");
    expect(en("dash.customProblemNoAppTraffic")).toContain("None of the apps you chose");
    expect(en("dash.customProblemAdapterGone")).toContain("adapter Custom mode was using disappeared");
  });

  it("is what the main page shows -- never the raw sentence -- from every status read", () => {
    const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
    expect(dashboard.match(/setSplitTunnelProblem\(readCustomModeProblem\(status\)\)/g)?.length).toBe(2);
    expect(dashboard).not.toMatch(/setSplitTunnelProblem\(status\.splitTunnelProblem/);
    expect(dashboard).toContain("{customModeProblemText(splitTunnelProblem, t)}");
    expect(dashboard).not.toMatch(/>\{splitTunnelProblem\}</);
  });
});

describe("the session timer for a tunnel found up at launch", () => {
  const READ_AT = 1_800_000_000_000;

  it("starts the service's age before the read", () => {
    expect(adoptedSince({ sessionSecs: 0 }, READ_AT)).toBe(READ_AT);
    expect(adoptedSince({ sessionSecs: 3_725 }, READ_AT)).toBe(READ_AT - 3_725_000);
    expect(adoptedSince({ sessionSecs: 12.9 }, READ_AT)).toBe(READ_AT - 12_000);
  });

  it("is nothing when the service said nothing usable -- never a guess", () => {
    for (const sessionSecs of [undefined, null, "60", -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(adoptedSince({ sessionSecs }, READ_AT), String(sessionSecs)).toBeNull();
    }
  });

  it("is set only over a tunnel up, and never over this window's own stamp", () => {
    const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
    const sync = dashboard.slice(dashboard.indexOf("async function syncFromService"), dashboard.indexOf("async function confirmTornDown"));
    expect(sync).toContain("else if (isTunnelUp(settled))");
    expect(sync).toContain("adoptedSince(lastStatusRef.current, Date.now())");
    expect(sync).toContain("setConnectedAt((own) => own ?? since)");
  });
});
