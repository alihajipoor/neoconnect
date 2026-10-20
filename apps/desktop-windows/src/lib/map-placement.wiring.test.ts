import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** The map and the ribbon are placed from boxes that do not change with the
 * connection state, so nothing moves when it does (WorldMap.tsx's contract,
 * and the calm rule). Layout cannot run here, so this pins the pieces that
 * make it true; the positions themselves were compared in headless Chrome
 * across the preview's states at 1440x900, 1280x800, 1180x760 and 940x700,
 * in both languages -- equal in every state at every wide size, and at
 * 940x700 the lights only fade where the band gives way. */

const css = readFileSync(new URL("../pearl.css", import.meta.url), "utf8");
const map = readFileSync(new URL("../components/main/WorldMap.tsx", import.meta.url), "utf8");

describe("what the map is placed by", () => {
  it("a tray of one height in every state", () => {
    expect(css).toMatch(/\.nx-tray \{\s*grid-area: tray;[^}]*block-size: 108px;/);
  });

  it("the switch's slot with three lines of its hint reserved, and the hint clamped to them", () => {
    expect(map).toContain("return r.y + r.h + gap + 3 * line;");
    expect(css).toMatch(/\.nx-ov > \.nx-modebar \.nx-modehint \{[^}]*-webkit-line-clamp: 3;/);
  });

  it("a switch that stays in its corner under a banner from 1100px, and keeps its box below that", () => {
    expect(css).toMatch(
      /@container app \(min-width: 900px\) and \(max-width: 1099\.98px\) \{\s*\.nx-app\[data-banner="1"\] \.nx-ov > \.nx-modebar \{\s*visibility: hidden;/,
    );
    expect(css).not.toMatch(/\.nx-app\[data-banner="1"\] \.nx-ov > \.nx-modebar \{\s*display: none;/);
  });

  it("a column whose width does not depend on whether it scrolls", () => {
    // It draws no scrollbar at all, so none comes and goes beside it
    // (desktop-hero-fit.test.ts); it kept a stable gutter before.
    const hero = css.slice(css.indexOf("    .nx-hero {\n      grid-area: hero;\n      z-index: 1;"));
    expect(hero.slice(0, hero.indexOf("}"))).toContain("scrollbar-width: none;");
  });

  it("a ribbon kept off the copy column, below the switch, above the band's geometry even once it gives way", () => {
    const band = map.slice(map.indexOf("// Compact wide: a band along the hero's bottom."));
    expect(band).toContain("const left = rtl ? area.x + 8 : copyEnd + 12;");
    expect(band).toContain("const right = rtl ? copyEnd - 12 : area.x + area.w - 8;");
    expect(band).toContain("const bottom = area.y + area.h - bandH - 16;");
  });

  it("lights that fade while the band gives way rather than leave", () => {
    expect(map).toContain('<div className="nx-lamps" data-off={shown ? undefined : "1"}>');
    expect(css).toMatch(/:is\(\.nx-lamps, \.nx-arcs\)\[data-off="1"\] \{\s*opacity: 0;/);
  });
});
