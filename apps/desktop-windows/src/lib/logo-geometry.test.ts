import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GlassLogo } from "../components/main/GlassLogo";
import { LOGO, MARK_TONE, capDegrees, ringArc, ringCovers } from "./logo-geometry";

/** The glass mark over the main page's map is the Neoxify logo, not a ring
 * that looks like it (owner, 2026-10-19): LogoMark's numbers, the app
 * icon's proportions, the logo's own two colours. */

const logoSource = readFileSync(new URL("../components/Logo.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../pearl.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8");

function render(tone?: "brand" | "cobalt"): string {
  return renderToStaticMarkup(createElement(GlassLogo, { x: 0, y: 0, size: 200, tone }));
}

/** Every <circle> in the markup, as attribute maps. */
function circles(html: string): Record<string, string>[] {
  return [...html.matchAll(/<circle ([^>]*?)\/?>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([a-z-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
  );
}

describe("LogoMark and the shared geometry agree", () => {
  it("draws the ring, the opening and the centre with the same numbers", () => {
    const { view, centre, ring, dot } = LOGO;
    expect(logoSource).toContain(`viewBox="0 0 ${view} ${view}"`);
    expect(logoSource).toMatch(new RegExp(`cx="${centre}"\\s+cy="${centre}"\\s+r="${ring.r}"`));
    expect(logoSource).toContain(`strokeWidth="${ring.width}"`);
    expect(logoSource).toContain(`strokeDasharray="${ring.dash[0]} ${ring.dash[1]}"`);
    expect(logoSource).toContain(`transform="rotate(${ring.rotate} ${centre} ${centre})"`);
    expect(logoSource).toContain('strokeLinecap="round"');
    expect(logoSource).toContain(`<circle cx="${centre}" cy="${centre}" r="${dot.r}"`);
  });

  it("and the same two colours", () => {
    expect(logoSource).toContain(`stopColor="${LOGO.colors.from}"`);
    expect(logoSource).toContain(`stopColor="${LOGO.colors.to}"`);
    expect(theme).toContain(`--logo-violet: ${LOGO.colors.from};`);
    expect(theme).toContain(`--logo-cyan: ${LOGO.colors.to};`);
  });

  it("one stroke and one gap: the dash covers the circumference once", () => {
    const circumference = 2 * Math.PI * LOGO.ring.r;
    expect(LOGO.ring.dash[0] + LOGO.ring.dash[1]).toBeGreaterThanOrEqual(circumference);
    expect(LOGO.ring.dash[0] + LOGO.ring.dash[1]).toBeLessThan(circumference + 1);
    const arc = ringArc();
    expect(arc.sweep).toBeCloseTo(261.9, 1);
    // The opening is at the top, just left of twelve o'clock.
    expect(ringCovers(270)).toBe(false);
    expect(ringCovers(250)).toBe(false);
    expect(ringCovers(90)).toBe(true);
    expect(ringCovers(0)).toBe(true);
    expect(ringCovers(180)).toBe(true);
    expect(capDegrees()).toBeCloseTo(9.55, 1);
  });
});

describe("GlassLogo is that mark, in glass", () => {
  const html = render();
  const all = circles(html);

  it("on LogoMark's square", () => {
    expect(html).toContain(`viewBox="0 0 ${LOGO.view} ${LOGO.view}"`);
  });

  it("its body ring is LogoMark's ring, in the logo's gradient", () => {
    const body = all.find((c) => c.class === "logo-ring");
    expect(body).toBeDefined();
    expect(body).toMatchObject({
      cx: String(LOGO.centre),
      cy: String(LOGO.centre),
      r: String(LOGO.ring.r),
      "stroke-width": String(LOGO.ring.width),
      "stroke-dasharray": `${LOGO.ring.dash[0]} ${LOGO.ring.dash[1]}`,
      "stroke-linecap": "round",
      transform: `rotate(${LOGO.ring.rotate} ${LOGO.centre} ${LOGO.centre})`,
      fill: "none",
    });
    expect(body?.stroke).toMatch(/^url\(#.+\)$/);
  });

  it("its body centre is LogoMark's centre", () => {
    const dot = all.find((c) => c.class === "logo-dot");
    expect(dot).toMatchObject({ cx: String(LOGO.centre), cy: String(LOGO.centre), r: String(LOGO.dot.r) });
  });

  it("every layer of the ring keeps the ring's radius, opening and turn", () => {
    const rings = all.filter((c) => c["stroke-dasharray"] !== undefined);
    expect(rings.length).toBeGreaterThanOrEqual(8);
    for (const ring of rings) {
      expect(ring.r).toBe(String(LOGO.ring.r));
      expect(ring["stroke-dasharray"]).toBe(`${LOGO.ring.dash[0]} ${LOGO.ring.dash[1]}`);
      expect(ring.transform).toBe(`rotate(${LOGO.ring.rotate} ${LOGO.centre} ${LOGO.centre})`);
      expect(ring["stroke-linecap"]).toBe("round");
    }
    // Nothing of the glass is wider than the edge's hairline around it.
    for (const ring of rings) expect(Number(ring["stroke-width"])).toBeLessThanOrEqual(LOGO.ring.width + 1);
  });

  it("violet to cyan by default, cobalt by one switch", () => {
    expect(MARK_TONE).toBe("brand");
    expect(html).toContain('data-tone="brand"');
    expect(html).toContain("stop-color:var(--mark-a)");
    expect(html).toContain("stop-color:var(--mark-b)");
    expect(render("cobalt")).toContain('data-tone="cobalt"');
    expect(css).toMatch(/\.nx-mark \{[^}]*--mark-a: var\(--logo-violet\);\s*--mark-b: var\(--logo-cyan\);/);
    expect(css).toMatch(/\.nx-mark\[data-tone="cobalt"\] \{\s*--mark-a: var\(--logo-cobalt-a\);\s*--mark-b: var\(--cobalt\);/);
  });

  it("decorative, and cheap: no filter, no canvas", () => {
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/<filter|<canvas|<foreignObject/);
  });

  it("its colour clears and its inside lights only under the verified tone", () => {
    expect(css).toMatch(/\.nx-app:is\(\[data-shown="ok"\], \[data-shown="caution"\]\) \.nx-mark :is\(\.frost-ring, \.frost-dot\) \{\s*opacity: 0;/);
    expect(css).toMatch(/\.nx-app:is\(\[data-shown="ok"\], \[data-shown="caution"\]\) \.nx-mark \.core-ring \{/);
    expect(css).not.toMatch(/data-shown="unverified"[^{]*\.nx-mark/);
  });
});

/** The app icon (src-tauri/icons), decoded here: an 8-bit RGBA PNG. */
function decodePng(path: URL): { w: number; h: number; px: Buffer } {
  const buf = readFileSync(path);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  expect([buf[24], buf[25], buf[28]]).toEqual([8, 6, 0]);
  const idat: Buffer[] = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (buf.toString("latin1", o + 4, o + 8) === "IDAT") idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let v = raw[y * (stride + 1) + 1 + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, px };
}

describe("the app icon has the same proportions", () => {
  const { w, px } = decodePng(new URL("../../src-tauri/icons/Square310x310Logo.png", import.meta.url));
  // The mark is violet to cyan on a dark tile: both ends are bright blue.
  const isMark = (x: number, y: number) => {
    const i = Math.round(y) * w * 4 + Math.round(x) * 4;
    return px[i + 3] > 200 && px[i + 2] > 170;
  };
  // The centre: the bright disc around the middle of the tile.
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = w / 2 - 50; y < w / 2 + 50; y++)
    for (let x = w / 2 - 50; x < w / 2 + 50; x++)
      if (isMark(x, y)) {
        n++;
        sx += x;
        sy += y;
      }
  const cx = sx / n;
  const cy = sy / n;
  /** Pixels per logo unit, from the centre's area. */
  const k = Math.sqrt(n / Math.PI) / LOGO.dot.r;

  it("a ring 21 units out and 7 wide, around a centre of 8", () => {
    const mids: number[] = [];
    const widths: number[] = [];
    for (let deg = 0; deg < 360; deg += 2) {
      const a = (deg * Math.PI) / 180;
      let inner: number | null = null;
      let outer = 0;
      for (let r = 13 * k; r < 28 * k; r += 0.25)
        if (isMark(cx + r * Math.cos(a), cy + r * Math.sin(a))) {
          inner ??= r;
          outer = r;
        }
      if (inner !== null && outer - inner > 6 * k) {
        mids.push((inner + outer) / 2 / k);
        widths.push((outer - inner) / k);
      }
    }
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    expect(mids.length).toBeGreaterThan(120);
    expect(Math.abs(mean(mids) - LOGO.ring.r)).toBeLessThan(0.6);
    expect(Math.abs(mean(widths) - LOGO.ring.width)).toBeLessThan(1.2);
  });

  it("with the opening where the dash and the turn put it", () => {
    const open: number[] = [];
    for (let deg = 0; deg < 360; deg++) {
      const a = (deg * Math.PI) / 180;
      if (!isMark(cx + LOGO.ring.r * k * Math.cos(a), cy + LOGO.ring.r * k * Math.sin(a))) open.push(deg);
    }
    const arc = ringArc();
    const from = arc.end + capDegrees();
    const to = arc.start + 360 - capDegrees();
    const measuredMid = (open[0] + open[open.length - 1]) / 2;
    expect(Math.abs(measuredMid - (from + to) / 2)).toBeLessThan(3);
    expect(Math.abs(open.length - (to - from))).toBeLessThan(8);
  });
});
