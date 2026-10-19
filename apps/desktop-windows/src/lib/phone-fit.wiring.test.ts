import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** The phone's main page fits one screen and does not scroll (owner,
 * 2026-10-19). Layout cannot run here, so this pins the pieces that make it
 * true; `scripts/check-phone-fit.mjs` measures it in headless Chrome on the
 * dev preview -- 360x640, 375x667, 390x844, 412x915 and 430x932 with their
 * safe areas, English and Persian, every main-page state -- and exits 1 on
 * any overflow. */

const css = readFileSync(new URL("../pearl.css", import.meta.url), "utf8");
const view = readFileSync(new URL("../components/main/MainView.tsx", import.meta.url), "utf8");
const map = readFileSync(new URL("../components/main/WorldMap.tsx", import.meta.url), "utf8");
const dash = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
const overlay = readFileSync(new URL("../components/overlay.tsx", import.meta.url), "utf8");

/** The body of the first rule for `selector` inside the narrow layout. */
function narrowRule(selector: string): string {
  const start = css.indexOf("/* ---------- NARROW: one screen, no page scroll (phones) ----------");
  expect(start).toBeGreaterThan(0);
  const block = css.slice(start);
  const at = block.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(0);
  return block.slice(at, block.indexOf("}", at));
}

describe("a phone's main page is one screen", () => {
  it("the page itself never scrolls", () => {
    expect(narrowRule("    .nx-ov")).toMatch(/overflow: hidden;/);
    expect(css).toMatch(/\.nx-app \{[^}]*max-height: 100dvh;/);
  });

  it("the column is a size container, so what tightens follows the room, not the state", () => {
    expect(narrowRule("    .nx-hero")).toMatch(/container: col \/ size;/);
    expect(css).toMatch(/@container col \(max-height: 560px\) \{/);
    expect(css).toMatch(/@container col \(max-height: 480px\) \{/);
  });

  it("the tagline scales with the room", () => {
    expect(narrowRule("    .nx-hero-copy > .nx-tag")).toMatch(/font-size: clamp\(24px, min\(10\.4cqw, 6\.2cqh\), 46px\);/);
  });

  it("the map's stage is the part that gives up room, and under STAGE_MIN draws nothing", () => {
    expect(narrowRule("    .nx-hero-copy > .nx-mapstage")).toMatch(/flex: 1 1 0;\s*min-height: 0;/);
    expect(map).toContain("export const STAGE_MIN = 96;");
    expect(map).toContain("if (w < 40 || h < STAGE_MIN) return NONE;");
  });

  it("the plan, the address, the details and the mode switch fold into one line and its sheet", () => {
    expect(narrowRule("    .nx-hero-copy > :is(.nx-details, .nx-hmet, .nx-modebar, .nx-subline)")).toMatch(/display: none;/);
    expect(narrowRule("    .nx-hero-copy > .nx-sumline")).toMatch(/display: flex;/);
    expect(view).toContain('className="nx-glass strong nx-sumline"');
    expect(view).toMatch(/<BottomSheet[\s\S]*?\{slots\.metrics\}[\s\S]*?\{slots\.subline\}[\s\S]*?\{details\}[\s\S]*?\{slots\.modeBar\}[\s\S]*?<\/BottomSheet>/);
    // Only a sheet scrolls, inside itself.
    expect(css).toMatch(/\.nx-sheet-body \{[^}]*overflow-y: auto;/);
    expect(overlay).toContain('role="dialog" aria-modal="true"');
  });

  it("the honest state never folds: the chip, the line, the sentence, banners, the device limit, leaks, errors", () => {
    const hidden = narrowRule("    .nx-hero-copy > :is(.nx-details, .nx-hmet, .nx-modebar, .nx-subline)");
    for (const kept of ["nx-chip", "nx-bigrow", "nx-hint", "nx-banner", "nx-slot", "nx-notes", "nx-err", "nx-hloc", "nx-actions"]) {
      expect(hidden).not.toContain(kept);
    }
    // Leaks and unprotected lookups stay in the column; only the
    // informational lines become "details".
    const notes = dash.slice(dash.indexOf("  const notes = ("), dash.indexOf("  // The way out of a failed connect"));
    expect(notes).toContain('<Note tone="danger">{t("dash.ipv6Escaping")}</Note>');
    expect(notes).toContain('<Note tone="danger">{t(unconfinedKey)}</Note>');
    expect(notes).not.toContain("Disclosure");
    expect(dash).toContain("details={details}");
    expect(dash).toContain("summary={subscription ? <SummaryLine plan={trayPlan} ip={ip} /> : null}");
  });

  it("the foot keeps its height: the way out sits beside the button", () => {
    expect(narrowRule("    .nx-hero-copy > .nx-actions")).toMatch(/flex-wrap: wrap;/);
    expect(narrowRule("    .nx-hero-copy > .nx-actions")).not.toMatch(/flex-direction: column;/);
  });

  it("safe areas: the header below the status bar, the nav above the home indicator", () => {
    expect(css).toContain("--safe-t: env(safe-area-inset-top, 0px);");
    expect(narrowRule("    .nx-mhead")).toMatch(/padding: calc\(var\(--safe-t\) \+ 4px\)/);
    expect(narrowRule("    .nx-ov")).toMatch(/padding: 0 20px calc\(var\(--nav-h\) \+ var\(--safe-b\) \+ 10px\);/);
  });

  it("scrolling comes back only as the last resort, inside the column", () => {
    expect(narrowRule("    .nx-hero")).toMatch(/overflow-y: auto;/);
  });
});
