import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DICTIONARIES as translations } from "./i18n";
import { isEffective } from "./split-tunnel";

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

/** Settings, Custom mode on, "Only these apps", nothing chosen: the card
 * said nothing went through the VPN, while the connect carried the whole
 * computer -- Custom mode with no apps changes nothing -- and the Overview
 * said so. Found in the release run on the test machine, 2026-11-19. The
 * card is the Linux app's too: it renders the Windows app's screens. */
describe("the Custom-mode card with no apps chosen", () => {
  it("is a state in which Custom mode changes nothing", () => {
    expect(isEffective({ enabled: true, apps: [], mode: "onlySelected", scopes: [], games: [] })).toBe(false);
  });

  it("says everything goes through the VPN, in both languages", () => {
    expect(translations.en["settings.customNoApps"]).toMatch(/everything on this computer goes through the VPN/);
    expect(translations.en["settings.customNoApps"]).not.toMatch(/nothing/i);
    expect(translations.fa["settings.customNoApps"]).toContain("همهٔ ترافیک این کامپیوتر از وی‌پی‌ان می‌گذرد");
    expect(translations.fa["settings.customNoApps"]).not.toContain("چیزی از وی‌پی‌ان نمی‌گذرد");
    // The fact the Overview states while nothing is up, and the All-except
    // card's, which was right already.
    expect(translations.en["mode.vpnHintIdle"]).toMatch(/everything on this computer goes through/);
    expect(translations.en["settings.customNoAppsExcept"]).toMatch(/everything goes through the VPN/);
  });

  it("is the sentence the card shows for it", () => {
    const card = readFileSync(new URL("../components/CustomModeCard.tsx", import.meta.url), "utf8");
    expect(card).toMatch(
      /settings\.apps\.length === 0 \? \([\s\S]*?settings\.mode === "allExcept"\s*\?\s*t\("settings\.customNoAppsExcept"\)\s*:\s*t\("settings\.customNoApps"\)/,
    );
  });
});
