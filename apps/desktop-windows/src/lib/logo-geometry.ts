/** The Neoxify mark's geometry, as `LogoMark` (components/Logo.tsx) draws it
 * and the app icon (src-tauri/icons) shows it: a broken ring around a solid
 * centre on a 64-unit square.
 *
 * Anything that draws the mark at another size or in another material -- the
 * glass mark over the main page's map (`GlassLogo`) -- takes these numbers
 * rather than its own, so it stays the logo and not a ring that looks like
 * it. logo-geometry.test.ts holds LogoMark and the icon to the same values. */

export const LOGO = {
  /** The viewBox side. */
  view: 64,
  centre: 32,
  ring: {
    r: 21,
    width: 7,
    /** One stroke and one gap: r=21 makes the circumference ~132. */
    dash: [96, 36] as const,
    /** Degrees, about the centre: where the stroke starts. SVG draws a
     * circle's stroke clockwise from three o'clock. */
    rotate: -58,
  },
  dot: { r: 8 },
  /** The logo's own gradient, violet to cyan, along the ring's diagonal. */
  colors: { from: "#8b5cf6", to: "#22d3ee" },
} as const;

/** Which colours the mark wears where it stands in for the brand on a page:
 * its own violet-to-cyan, or the app's cobalt. */
export type LogoTone = "brand" | "cobalt";

/** The one switch for the glass mark over the main page's map: "brand"
 * wears the logo's own violet-to-cyan, "cobalt" the app's accent
 * (pearl.css maps both, in Pearl and Smoked). */
export const MARK_TONE: LogoTone = "brand";

/** The arc the ring's stroke covers, in screen degrees (clockwise from three
 * o'clock), without its round caps: from the dash's start to its end. */
export function ringArc(): { start: number; end: number; sweep: number } {
  const { r, dash, rotate } = LOGO.ring;
  const sweep = (dash[0] / (2 * Math.PI * r)) * 360;
  return { start: rotate, end: rotate + sweep, sweep };
}

/** How far a round cap reaches past the arc's end, in degrees at the ring's
 * radius. */
export function capDegrees(): number {
  return ((LOGO.ring.width / 2 / LOGO.ring.r) * 180) / Math.PI;
}

/** Whether the ring's stroke covers this screen angle (degrees), caps
 * excluded. */
export function ringCovers(deg: number): boolean {
  const { start, sweep } = ringArc();
  const d = (((deg - start) % 360) + 360) % 360;
  return d <= sweep;
}

/** A point on a circle about the mark's centre, at a screen angle. */
export function onCircle(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [LOGO.centre + r * Math.cos(a), LOGO.centre + r * Math.sin(a)];
}

/** An open arc about the centre, clockwise from `from` to `to` (degrees). */
export function arcPath(r: number, from: number, to: number): string {
  const [x0, y0] = onCircle(r, from);
  const [x1, y1] = onCircle(r, to);
  const large = (((to - from) % 360) + 360) % 360 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
