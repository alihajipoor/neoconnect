import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DICTIONARIES as translations } from "./i18n";

/** The line under the mode switch said "only the apps you chose go
 * through Neoxify" in both Custom modes. In "All except these" that is
 * the opposite of the truth: the chosen apps are the ones that bypass.
 * Found in the VM on 2026-10-07, with curl.exe excluded and going
 * direct while the header claimed it was the only thing carried. */
describe("the Custom-mode line under the mode switch", () => {
  it("has an All-except sentence in both languages that says the chosen apps are left out", () => {
    expect(translations.en["dash.modeCustomExceptHint"]).toMatch(/except the apps you chose/);
    expect(translations.fa["dash.modeCustomExceptHint"]).toBeTruthy();
    expect(translations.fa["dash.modeCustomExceptHint"]).not.toBe(translations.fa["dash.modeCustomHint"]);
  });

  it("is chosen by the saved mode, not shown the same for both", () => {
    const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
    expect(dashboard).toMatch(/setCustomExcept\(settings\.mode === "allExcept"\)/);
    expect(dashboard).toMatch(/customExcept \? "dash\.modeCustomExceptHint" : "dash\.modeCustomHint"/);
  });
});
