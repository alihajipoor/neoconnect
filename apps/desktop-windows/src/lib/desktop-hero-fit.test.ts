import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* ------------------------------------------------------------------ *
 * The main page's copy column at the first-launch 1180x760 (VM,
 * 2026-10-20): connected, with "Connection details" there, it was 638 px
 * of copy in a 574 px column in Persian (582 in English), and a scrollbar
 * stood beside it.
 *
 * Now every ordinary state fits there with nothing to scroll -- a closer
 * rhythm at a laptop's height, Persian's sentence in the column's own
 * measure, no gap kept under a closed details toggle -- and the column,
 * which still scrolls for a card, a note, a banner or the opened details,
 * draws no scrollbar: the fade, "More below" and the details opening into
 * view say what is below. Layout cannot run here: the pixels are measured
 * in headless Chrome at every desktop size, both languages and every state
 * (`scripts/check-phone-fit.mjs --desktop`: "scrollbar", "scrolls"); this
 * pins the rules that make them.
 * ------------------------------------------------------------------ */

const css = readFileSync(new URL("../pearl.css", import.meta.url), "utf8");

/** The wide layout's block. */
const wide = css.slice(css.indexOf("  /* ---------- WIDE ---------- */"), css.indexOf("  /* Compact wide: a banner needs the switch's corner"));

/** The body of the first rule for `selector` in `block`. */
function rule(block: string, selector: string): string {
  const at = block.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return block.slice(at, block.indexOf("}", at));
}

describe("the wide copy column", () => {
  it("scrolls, and draws no scrollbar or gutter beside the copy", () => {
    expect(wide.length).toBeGreaterThan(0);
    const hero = rule(wide, "    .nx-hero");
    expect(hero).toContain("overflow-y: auto;");
    expect(hero).toContain("scrollbar-width: none;");
    expect(hero).not.toContain("scrollbar-width: thin;");
    expect(hero).not.toContain("scrollbar-gutter");
  });

  it("says what is below it by the fade and the pill instead", () => {
    expect(wide).toMatch(/\.nx-ov\[data-more="1"\] > \.nx-hero \{\s*-webkit-mask-image/);
    const view = readFileSync(new URL("../components/main/MainView.tsx", import.meta.url), "utf8");
    expect(view).toContain('className="nx-glass strong nx-morecue"');
    // An opened "Connection details" is brought into view (Disclosure).
    const ui = readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");
    expect(ui).toContain('panel.current.scrollIntoView?.({ block: "nearest"');
  });

  it("sets Persian's sentence in the column's own measure", () => {
    expect(rule(wide, "    .nx-hint")).toContain("max-width: 40ch;");
    expect(rule(wide, '    html[lang="fa"] .nx-hint')).toContain("max-width: none;");
  });

  it("keeps no gap under a closed details toggle", () => {
    expect(rule(css, "  .nx-details > .nx-dpanel:not(.open)")).toContain("display: none;");
  });

  it("is closer in rhythm at a laptop's height, closer still below 660px", () => {
    const laptop = css.indexOf("@container app (min-width: 900px) and (max-height: 820px) {");
    const short = css.indexOf("@container app (min-width: 900px) and (max-height: 660px) {");
    expect(laptop).toBeGreaterThan(0);
    // Before the shorter one, which overrides it below 660px.
    expect(laptop).toBeLessThan(short);
    expect(rule(css.slice(laptop), "    .nx-hero-copy")).toContain("gap: clamp(10px, 1.4cqh, 18px);");
  });
});
