import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** Sign-in and registration fit one screen (owner, 2026-10-19) in the
 * states a blocked network brings too -- a failure, the intranet's note,
 * both, the backup route offered -- and an iPhone's three providers fit
 * their row. Layout cannot run here; `scripts/check-phone-fit.mjs` measures
 * every one of these in headless Chrome at each phone size, the windows and
 * the tablet, in English and Persian. This pins that it still asks for
 * them, that the preview can draw them, and that the app itself never
 * draws a seeded state. */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const check = read("../../scripts/check-phone-fit.mjs");
const pages = read("../preview/PreviewPages.tsx");
const css = read("../pages.css");

const STATES = [
  "signinError",
  "signinIntranet",
  "signinIntranetError",
  "signinIos",
  "registerError",
  "registerRelayOffer",
  "registerIos",
];

describe("sign-in in the states a blocked network brings", () => {
  it("is measured by the fit check, and drawn by the preview", () => {
    for (const state of STATES) {
      expect(check, state).toContain(`"${state}",`);
      expect(pages, state).toMatch(new RegExp(`\\b${state}: "`));
    }
    // Every button that submits, the backup route's offer among them, and
    // every message, on screen; no provider's label cut.
    expect(check).toContain("frame.querySelectorAll('.nx-auth-submit')");
    expect(check).toContain("frame.querySelectorAll('.nx-auth-card .nx-msg')");
    expect(check).toContain("frame.querySelectorAll('.nx-soc')");
    expect(check).toContain("providers drawn, not 3");
  });

  it("is seeded only in the preview", () => {
    for (const app of ["../App.tsx", "../../../mobile/src/App.tsx", "../../../web-portal/src/App.tsx"]) {
      expect(read(app), app).not.toMatch(/\bseed=/);
    }
  });

  it("draws three providers side by side as logos, never as \"Apple\" alone", () => {
    expect(css).toMatch(/\.nx-social-row\[data-count="3"\] \.nx-btn\.nx-soc \.short \{\s*display: none;/);
  });
});
