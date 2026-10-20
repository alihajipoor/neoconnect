import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** The phone's main page fits one screen and does not scroll (owner,
 * 2026-10-19). Layout cannot run here, so this pins the pieces that make it
 * true; `scripts/check-phone-fit.mjs` measures it in headless Chrome on the
 * dev preview -- 360x640, 375x667, 390x844, 412x915 and 430x932 with their
 * safe areas, English and Persian, every main-page state -- and exits 1 on
 * any overflow, any cut text, or any part of the foot, the stage or the mark
 * that moves with the state. */

const css = readFileSync(new URL("../pearl.css", import.meta.url), "utf8");
const view = readFileSync(new URL("../components/main/MainView.tsx", import.meta.url), "utf8");
const map = readFileSync(new URL("../components/main/WorldMap.tsx", import.meta.url), "utf8");
const dash = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
const overlay = readFileSync(new URL("../components/overlay.tsx", import.meta.url), "utf8");
const hero = readFileSync(new URL("../components/main/Hero.tsx", import.meta.url), "utf8");
const preview = readFileSync(new URL("../preview/PreviewApp.tsx", import.meta.url), "utf8");
const ui = readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");

/** The body of the first rule for `selector` inside the narrow layout. */
function narrowRule(selector: string): string {
  const start = css.indexOf("/* ---------- NARROW: one screen, no page scroll (phones) ----------");
  expect(start).toBeGreaterThan(0);
  const block = css.slice(start);
  const at = block.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(0);
  return block.slice(at, block.indexOf("}", at));
}

/** The rule that folds parts into the summary line's sheet. */
const FOLDED = "    .nx-hero-copy > :is(.nx-details, .nx-hmet, .nx-modebar),\n    .nx-hero-copy > .nx-sublinebox:not([data-stays]) > .nx-subline";

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

  it("the plan, the address and the details fold into one line and its sheet", () => {
    expect(narrowRule(FOLDED)).toMatch(/display: none;/);
    expect(narrowRule("    .nx-hero-copy > .nx-sumline")).toMatch(/display: flex;/);
    expect(view).toContain('className="nx-glass strong nx-sumline"');
    const sheet = view.slice(view.indexOf("<BottomSheet"), view.indexOf("</BottomSheet>"));
    expect(sheet).toMatch(/\{slots\.metrics\}[\s\S]*?\{sublineFolds \? slots\.subline : null\}[\s\S]*?\{details\}/);
    // Gaming mode is Windows only: the phone's sheet offers no VPN / Gaming
    // switch.
    expect(sheet).not.toContain("modeBar");
    // Only a sheet scrolls, inside itself.
    expect(css).toMatch(/\.nx-sheet-body \{[^}]*overflow-y: auto;/);
    expect(overlay).toContain('role="dialog" aria-modal="true"');
  });

  it("the summary line's name starts with what it opens and holds the words on it", () => {
    const button = view.slice(view.indexOf('className="nx-glass strong nx-sumline"'), view.indexOf("</button>"));
    expect(button).not.toContain("aria-label");
    expect(button).toContain('<span className="nx-sr">{t("sum.open")}: </span>');
    // Counts in the reader's digits.
    expect(button).toContain("formatNumber(sheetCount, language)");
    expect(ui).toContain("formatNumber(count, language)");
  });

  it("the summary line shows whole pieces, never an ellipsis inside one", () => {
    const sum = css.slice(css.indexOf("  .nx-sum {"), css.indexOf("  .nx-sum .v {"));
    expect(sum).toMatch(/flex-wrap: wrap;/);
    expect(sum).toMatch(/overflow: hidden;/);
    expect(sum).not.toContain("text-overflow");
  });

  it("a failover to another country stays in the column; a protocol change folds", () => {
    expect(view).toContain('<div className="nx-sublinebox" data-stays={slots.subline && slots.sublineStays ? "1" : undefined}>');
    expect(dash).toContain("sublineStays={Boolean(failedOverTo?.fromRegion)}");
    // On a phone the box adds nothing to the column: its line is placed by
    // itself, or folded into the sheet.
    expect(narrowRule("    .nx-sublinebox")).toMatch(/display: contents;/);
  });

  it("wider windows keep the subline's row in every state, so a countdown or a rung moves nothing", () => {
    // Drawn whether or not it says anything, and two lines tall.
    expect(view).not.toContain("{slots.subline ? (");
    const box = css.slice(css.indexOf("  .nx-sublinebox {"), css.indexOf("}", css.indexOf("  .nx-sublinebox {")));
    expect(box).toMatch(/display: flex;/);
    expect(box).toMatch(/min-height: calc\(2lh - 4px\);/);
  });

  it("the honest state never folds: the chip, the line, the sentence, banners, the device limit, leaks, errors", () => {
    const hidden = narrowRule(FOLDED);
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

  it("the foot keeps still: the way out stays on the button's row, in short words", () => {
    expect(narrowRule("    .nx-hero-copy > .nx-actions")).toMatch(/flex-wrap: nowrap;/);
    expect(narrowRule("    .nx-hero-copy > .nx-actions")).not.toMatch(/flex-direction: column;/);
    expect(narrowRule("    .nx-hero-copy > .nx-actions > .nx-btn")).toMatch(/flex: 1 1 0;\s*min-width: 0;/);
    expect(narrowRule("    .nx-hero-copy > .nx-actions > .nx-btn.ghost")).toMatch(/flex: none;/);
    expect(narrowRule("    .nx-wayout > .ls")).toMatch(/display: inline;/);
    // The full words stay the accessible name.
    expect(hero).toContain('<PillButton variant="ghost" className="nx-wayout" aria-label={label} onClick={onClick}>');
    for (const source of [dash, preview]) {
      expect(source).toContain('<WayOut label={t("dash.reconnectStop")} short={t("btn.stopShort")}');
      expect(source).toContain('<WayOut label={t("btn.stop")} short={t("btn.stopShort")}');
      expect(source).toContain('<WayOut label={t("btn.tryAnother")} short={t("btn.tryAnotherShort")}');
    }
  });

  it("the sentence is as tall as the longest it can say, so a longer one moves nothing", () => {
    // At every width (design-system.md 4.6): the desktop's button sits under
    // the sentence, and must not move with it either.
    const rsv = css.slice(css.indexOf("  .nx-hint > .rsv {"), css.indexOf("}", css.indexOf("  .nx-hint > .rsv {")));
    expect(rsv).toMatch(/visibility: hidden;/);
    expect(rsv).not.toMatch(/display: none;/);
    expect(hero).toContain('<span className="rsv" aria-hidden>');
    expect(preview).toContain("reserve={hintReserve}");
    expect(preview).toContain(
      'const hintReserve: readonly TranslationKey[] = sc.hold ? [...HEADLINE_HINTS, "hold.holding", "hold.heldAfterDrop"] : HEADLINE_HINTS;',
    );
    // The main page's: the same, and the reconnect hold's sentence where the
    // setting can make the hint say it (lib/reconnect-hold.ts).
    expect(dash).toContain("reserve={hintReserve}");
    expect(dash).toContain(
      'const hintReserve: readonly HintKey[] = holdSetting ? [...HEADLINE_HINTS, "hold.holding", "hold.heldAfterDrop"] : HEADLINE_HINTS;',
    );
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
