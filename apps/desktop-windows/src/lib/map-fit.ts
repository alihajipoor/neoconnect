import geo from "./map-geo.json";

/** The world map's arithmetic: where the box around the listed countries
 * goes in a stage, where each light lands, and where the glass ribbon may
 * sit without covering one (design-system.md 5.1 and 5.2).
 *
 * Pure numbers, so the "never over a light" rule can be pinned without a
 * screen; `components/main/WorldMap.tsx` reads the rectangles and applies
 * the result. Map units are grid steps of the generated SVG: dot (i, j) is
 * at (i, j), and an anchor's (x, y) is in the same units. */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Square {
  x: number;
  y: number;
  s: number;
}
export interface Point {
  cc: string;
  x: number;
  y: number;
}
/** Grid to pixels: a grid point (gx, gy) lands at (ox + gx * k, oy + gy * k). */
export interface Fit {
  k: number;
  ox: number;
  oy: number;
}

export const MAP_COLS: number = geo.grid.cols;
export const MAP_ROWS: number = geo.grid.rows;
export const ANCHORS: Readonly<Record<string, { x: number; y: number }>> = geo.anchors;
export const LISTED_BOX: Box = geo.listedBox;

/** Room kept between the box and the stage's edges, in pixels. */
export const MAP_PAD = 14;
/** The map never grows past a 9px dot pitch: beyond that the dots read as
 * a pattern, not a map. */
export const MAP_KMAX = 9;
/** Lights closer than this are nudged apart, at most `LAMP_MAX_NUDGE`
 * each: display, not data. */
export const LAMP_MIN_SEP = 10;
export const LAMP_MAX_NUDGE = 6;
/** The ribbon's box, grown by this, may not hold a light's centre. */
export const RIBBON_MARGIN = 12;
/** Below this the ribbon steps aside rather than shrink further: in a
 * phone's or a medium window's stage, where the map is the column's last
 * part and a smaller mark would crowd its lights. */
export const RIBBON_MIN = 96;
/** In a desktop window's scene (the wide layouts) the mark scales down to
 * this before it steps aside: the compact window fitted to a 1280x720
 * screen at 150% (922x648) has 92px beside the copy, and the mark vanished
 * there at the 96px minimum. At 64px the glass still reads as the logo. */
export const RIBBON_MIN_WINDOW = 64;

/** The box around the countries this list can light: the generated listed
 * box, widened for any other anchored country in the list. It depends on
 * the route list alone, never on the connection state, so the map does not
 * move when the state changes. */
export function boxFor(countries: readonly string[]): Box {
  const box = { ...LISTED_BOX };
  for (const cc of countries) {
    const a = ANCHORS[cc];
    if (!a) continue;
    box.x0 = Math.min(box.x0, a.x);
    box.y0 = Math.min(box.y0, a.y);
    box.x1 = Math.max(box.x1, a.x);
    box.y1 = Math.max(box.y1, a.y);
  }
  return box;
}

/** Fits `box` into `stage`: centred across, and either centred down or
 * resting on the stage's bottom (`share` of its height at most), the way
 * the wide strip keeps its lights low and its ribbon above them. Null when
 * the stage is too small to hold anything. */
export function fitBox(box: Box, stage: Rect, { align = "center", share = 1 }: { align?: "center" | "bottom"; share?: number } = {}): Fit | null {
  const bw = Math.max(box.x1 - box.x0, 1);
  const bh = Math.max(box.y1 - box.y0, 1);
  const k = Math.min((stage.w - 2 * MAP_PAD) / bw, (stage.h * share - 2 * MAP_PAD) / bh, MAP_KMAX);
  if (!(k > 0.5)) return null;
  const left = stage.x + (stage.w - bw * k) / 2;
  const top = align === "bottom" ? stage.y + stage.h - MAP_PAD - bh * k : stage.y + (stage.h - bh * k) / 2;
  return { k, ox: left - box.x0 * k, oy: top - box.y0 * k };
}

/** Where each anchored country's light lands, nudged apart where the scale
 * is too small to separate them -- never by more than `LAMP_MAX_NUDGE`. */
export function lightPoints(countries: readonly string[], fit: Fit): Point[] {
  const points = countries
    .filter((cc) => ANCHORS[cc])
    .map((cc) => ({ cc, x: fit.ox + ANCHORS[cc].x * fit.k, y: fit.oy + ANCHORS[cc].y * fit.k }));
  const home = points.map((p) => ({ x: p.x, y: p.y }));
  for (let pass = 0; pass < 10; pass++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d >= LAMP_MIN_SEP) continue;
        const push = (LAMP_MIN_SEP - d) / 2;
        // Coincident points part along a fixed direction rather than NaN.
        const ux = d === 0.01 ? 1 : dx / d;
        const uy = d === 0.01 ? 0 : dy / d;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        moved = true;
      }
    }
    points.forEach((p, i) => {
      const dx = p.x - home[i].x;
      const dy = p.y - home[i].y;
      const d = Math.hypot(dx, dy);
      if (d > LAMP_MAX_NUDGE) {
        p.x = home[i].x + (dx / d) * LAMP_MAX_NUDGE;
        p.y = home[i].y + (dy / d) * LAMP_MAX_NUDGE;
      }
    });
    if (!moved) break;
  }
  return points;
}

/** Whether a square, grown by the margin, holds none of the points. */
export function clearOf(square: Square, points: readonly { x: number; y: number }[], margin = RIBBON_MARGIN): boolean {
  return points.every(
    (p) => p.x < square.x - margin || p.x > square.x + square.s + margin || p.y < square.y - margin || p.y > square.y + square.s + margin,
  );
}

/** The ribbon's place: the wanted square, shrunk by tenths around its centre
 * until it covers no light; null -- it steps aside -- when that leaves it
 * under `min` (`RIBBON_MIN`, or `RIBBON_MIN_WINDOW` in a desktop window's
 * scene). */
export function placeRibbon(wanted: Square, points: readonly { x: number; y: number }[], min: number = RIBBON_MIN): Square | null {
  let square = { ...wanted };
  for (let i = 0; i < 12 && !clearOf(square, points); i++) {
    const s = square.s * 0.9;
    square = { x: square.x + (square.s - s) / 2, y: square.y + (square.s - s) / 2, s };
  }
  return square.s >= min && clearOf(square, points) ? square : null;
}
