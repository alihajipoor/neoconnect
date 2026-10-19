import { describe, expect, it } from "vitest";
import {
  ANCHORS,
  LAMP_MAX_NUDGE,
  LISTED_BOX,
  MAP_KMAX,
  MAP_PAD,
  RIBBON_MARGIN,
  RIBBON_MIN,
  boxFor,
  clearOf,
  fitBox,
  lightPoints,
  placeRibbon,
} from "./map-fit";

/** The map's placement: the listed box fits its stage, lights never crowd
 * past recognition, and the ribbon never covers a light (design-system.md
 * 5.1 and 5.2). */

const LISTED = ["gb", "fr", "de", "fi", "tr", "ir", "sg"];

describe("boxFor", () => {
  it("is the generated listed box for the countries listed today", () => {
    expect(boxFor(LISTED)).toEqual(LISTED_BOX);
    expect(boxFor([])).toEqual(LISTED_BOX);
  });

  it("widens for another anchored country in the list, and ignores one with no anchor", () => {
    const box = boxFor([...LISTED, "us", "jp"]);
    expect(box.x0).toBe(ANCHORS.us.x);
    expect(box.x1).toBe(LISTED_BOX.x1);
  });
});

describe("fitBox", () => {
  it("centres the box in the stage and keeps the padding", () => {
    const stage = { x: 100, y: 50, w: 400, h: 300 };
    const fit = fitBox(LISTED_BOX, stage)!;
    const left = fit.ox + LISTED_BOX.x0 * fit.k;
    const right = fit.ox + LISTED_BOX.x1 * fit.k;
    expect(left - stage.x).toBeCloseTo(stage.x + stage.w - right, 6);
    expect(left).toBeGreaterThanOrEqual(stage.x + MAP_PAD - 1e-9);
    const top = fit.oy + LISTED_BOX.y0 * fit.k;
    const bottom = fit.oy + LISTED_BOX.y1 * fit.k;
    expect(top).toBeGreaterThanOrEqual(stage.y + MAP_PAD - 1e-9);
    expect(bottom).toBeLessThanOrEqual(stage.y + stage.h - MAP_PAD + 1e-9);
  });

  it("rests the box on the stage's bottom when asked, within its share of the height", () => {
    const stage = { x: 0, y: 0, w: 320, h: 600 };
    const fit = fitBox(LISTED_BOX, stage, { align: "bottom", share: 0.5 })!;
    expect(fit.oy + LISTED_BOX.y1 * fit.k).toBeCloseTo(stage.h - MAP_PAD, 6);
    expect(fit.oy + LISTED_BOX.y0 * fit.k).toBeGreaterThanOrEqual(stage.h / 2 - 1e-9);
  });

  it("never grows past the largest dot pitch, and gives up on a stage too small", () => {
    expect(fitBox(LISTED_BOX, { x: 0, y: 0, w: 5000, h: 5000 })!.k).toBe(MAP_KMAX);
    expect(fitBox(LISTED_BOX, { x: 0, y: 0, w: 30, h: 30 })).toBeNull();
  });
});

describe("lightPoints", () => {
  it("places each anchored country, and nothing for one without an anchor", () => {
    const pts = lightPoints(["de", "jp"], { k: 4, ox: 10, oy: 20 });
    expect(pts).toEqual([{ cc: "de", x: 10 + ANCHORS.de.x * 4, y: 20 + ANCHORS.de.y * 4 }]);
  });

  it("nudges crowded lights apart by no more than the limit", () => {
    // At a small scale London, Paris and Frankfurt sit within a few pixels.
    const fit = { k: 2, ox: 0, oy: 0 };
    const pts = lightPoints(LISTED, fit);
    for (const p of pts) {
      const home = { x: ANCHORS[p.cc].x * fit.k, y: ANCHORS[p.cc].y * fit.k };
      expect(Math.hypot(p.x - home.x, p.y - home.y)).toBeLessThanOrEqual(LAMP_MAX_NUDGE + 1e-9);
    }
    const close = (a: string, b: string) => {
      const pa = pts.find((p) => p.cc === a)!;
      const pb = pts.find((p) => p.cc === b)!;
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };
    const raw = Math.hypot((ANCHORS.gb.x - ANCHORS.fr.x) * fit.k, (ANCHORS.gb.y - ANCHORS.fr.y) * fit.k);
    expect(close("gb", "fr")).toBeGreaterThan(raw);
  });
});

describe("placeRibbon", () => {
  const points = [
    { x: 200, y: 200 },
    { x: 260, y: 330 },
  ];

  it("keeps the wanted square when it covers no light", () => {
    const wanted = { x: 0, y: 0, s: 150 };
    expect(placeRibbon(wanted, points)).toEqual(wanted);
  });

  it("shrinks around its centre until no light is under it or its margin", () => {
    // A light near the wanted square's corner, as Singapore sits under the
    // strip's ribbon at some sizes.
    const corner = [{ x: 230, y: 230 }];
    const wanted = { x: 0, y: 0, s: 240 };
    const placed = placeRibbon(wanted, corner)!;
    expect(placed.s).toBeLessThan(wanted.s);
    expect(placed.s).toBeGreaterThanOrEqual(RIBBON_MIN);
    expect(clearOf(placed, corner, RIBBON_MARGIN)).toBe(true);
    expect(placed.x + placed.s / 2).toBeCloseTo(wanted.x + wanted.s / 2, 6);
  });

  it("steps aside rather than shrink below the minimum or cover a light", () => {
    expect(placeRibbon({ x: 150, y: 150, s: 120 }, points)).toBeNull();
  });

  it("never returns a square over a light, across many placements", () => {
    for (let i = 0; i < 400; i++) {
      const wanted = { x: (i * 37) % 300, y: (i * 53) % 300, s: 90 + ((i * 29) % 260) };
      const placed = placeRibbon(wanted, points);
      if (placed) expect(clearOf(placed, points, RIBBON_MARGIN)).toBe(true);
    }
  });
});
