import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The Pearl and Smoked tokens, read from theme.css as the app ships them,
 * and the WCAG 2 contrast of every pair that carries information.
 *
 * Text that matters must reach 4.5:1 over the worst colour it can sit on,
 * translucent fills composited over the base first; the focus ring 3:1.
 * `--ink-3` is decoration only and is not held to it. */

const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

type Rgba = [number, number, number, number];

function parse(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1].split(",").map((s) => s.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`not a colour: ${value}`);
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = block(":root");
const dark = { ...light, ...block(':root[data-theme="dark"]') };

describe.each([
  ["Pearl", light],
  ["Smoked", dark],
])("the %s tokens", (_name, tokens) => {
  const c = (name: string) => parse(tokens[name]);
  const base = c("base");
  const on = (fill: string, ground: Rgba = base) => over(c(fill), ground);

  it("keep primary and secondary text at 4.5:1 on the base and on the scene's worst colour", () => {
    for (const ground of [base, c("shade"), c("far"), c("sky"), on("scrim-copy")]) {
      expect(ratio(c("ink"), ground)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c("ink-2"), ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keep text on the glass and content surfaces at 4.5:1", () => {
    for (const surface of ["glass-strong", "glass-solid", "solid", "side-bg", "chip-bg"]) {
      // Over the darkest scene colour behind them, the worst case for the
      // light theme's surfaces and over the base for the dark one's.
      for (const ground of [base, c("shade")]) {
        expect(ratio(c("ink"), on(surface, ground)), surface).toBeGreaterThanOrEqual(4.5);
        expect(ratio(c("ink-2"), on(surface, ground)), surface).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Fields sit inside the glass, never on the scene itself.
    for (const ground of [base, c("shade")]) {
      const field = on("field", on("glass-strong", ground));
      expect(ratio(c("ink"), field)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c("ink-2"), field)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keep white on cobalt, and cobalt text on its selection pill, at 4.5:1", () => {
    expect(ratio(c("on-cobalt"), c("cobalt"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c("on-cobalt"), c("cobalt-hover"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c("cobalt-ink"), on("select"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keep every state's ink at 4.5:1 on its own tint", () => {
    for (const tone of ["ok", "hl", "warn", "danger", "muted"]) {
      expect(ratio(c(`${tone}-ink`), on(`${tone}-tint`)), tone).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keep text at 4.5:1 over the world map, a dot included, and its lights at 3:1", () => {
    // The map passes behind the copy (design-system.md 5.2): secondary text
    // must hold on the canvas and directly over a dot, without the veil.
    for (const ground of [c("map-bg-top"), c("map-bg"), c("map-dot")]) {
      expect(ratio(c("ink"), ground)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c("ink-2"), ground)).toBeGreaterThanOrEqual(4.5);
    }
    // A light is a graphic that carries meaning: 3:1 against the canvas.
    for (const lamp of ["lamp", "lamp-idle"]) {
      expect(ratio(c(lamp), c("map-bg")), lamp).toBeGreaterThanOrEqual(3);
    }
  });

  it("keep the focus ring at 3:1 against the base and against its own halo", () => {
    expect(ratio(c("focus"), base)).toBeGreaterThanOrEqual(3);
    expect(ratio(c("focus"), on("focus-halo"))).toBeGreaterThanOrEqual(3);
  });
});
