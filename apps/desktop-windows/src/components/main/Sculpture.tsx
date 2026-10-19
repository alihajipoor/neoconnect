import { useId } from "react";

/** The glass ribbon over the world map: the Neoxify mark -- a broken ring
 * around a solid centre, the gap across the top -- as a ribbon that twists
 * by half a turn along its arc (design-system.md 5.1).
 *
 * This is the vector stand-in the spec names for the flat tier and for
 * until the pre-rendered glass images exist, drawn to read as glass rather
 * than as a solid: a clear body, pearl at the lit edge and nearly
 * transparent at the shaded one, with a magnified piece of the dotted map
 * inside it (the refraction), polished rims and a darker hairline for its
 * silhouette, two specular streaks from the upper left, a soft contact
 * shadow, and a clear bead at the centre. Colour lives only inside: a thin
 * cobalt band along the arc, and an inner core that is steel until the
 * tunnel is verified and then cross-fades to cobalt -- never more than
 * about half opaque, so the ribbon stays lighter than the tagline.
 * Decorative: `aria-hidden`, and it says nothing the chip does not.
 *
 * Its only states come from the app root, in CSS: the core follows
 * `data-shown` (so it holds through a brief gap like everything else), and
 * a light sweep crosses it while `data-busy` -- static under reduced
 * motion. It is not mirrored in RTL: the light comes from the top left. */

const C = 50;
const R = 31;
const SPAN = 310;
const START = -65;

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

/** Half the ribbon's visible width at `t` along it: a lens cross-section
 * (half-width .31R, half-thickness .16R) turning by pi. */
function halfWidth(t: number): number {
  const phi = Math.PI * t;
  return R * Math.hypot(0.31 * Math.cos(phi), 0.16 * Math.sin(phi));
}

/** The ribbon's outline; `k` below 1 is a narrower ribbon inside it, the
 * core the glass carries. */
function ribbonPath(k = 1): string {
  const steps = 64;
  const outer: string[] = [];
  const inner: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const deg = START + SPAN * t;
    const hw = halfWidth(t) * k;
    outer.push(polar(R + hw, deg).map((v) => v.toFixed(2)).join(" "));
    inner.push(polar(R - hw, deg).map((v) => v.toFixed(2)).join(" "));
  }
  const capEnd = (halfWidth(1) * k).toFixed(2);
  const capStart = (halfWidth(0) * k).toFixed(2);
  return (
    `M${outer[0]}L${outer.slice(1).join("L")}` +
    `A${capEnd} ${capEnd} 0 0 1 ${inner[steps]}` +
    `L${inner.slice(0, steps).reverse().join("L")}` +
    `A${capStart} ${capStart} 0 0 1 ${outer[0]}Z`
  );
}

function arcPath(r: number, from: number, to: number): string {
  const [x0, y0] = polar(r, from);
  const [x1, y1] = polar(r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const RIBBON = ribbonPath();
const CORE = ribbonPath(0.42);
const BAND = arcPath(R, START + 6, START + SPAN - 6);
const STREAK = arcPath(R + 6.5, 150, 212);
const STREAK_2 = arcPath(R - 5, 196, 236);

export function Sculpture({ x, y, size, float = false }: { x: number; y: number; size: number; float?: boolean }) {
  const id = useId().replace(/:/g, "");
  const glass = `${id}g`;
  const steel = `${id}s`;
  const cobalt = `${id}c`;
  const dots = `${id}d`;
  const lens = `${id}l`;
  const lensMask = `${id}n`;
  const bead = `${id}b`;
  const beadOk = `${id}k`;
  const shadow = `${id}h`;
  const sheen = `${id}w`;
  const clip = `${id}m`;
  return (
    <div className="nx-rib" aria-hidden data-float={float ? "1" : undefined} style={{ left: x, top: y, width: size, height: size }}>
      <svg viewBox="0 0 100 100" focusable="false">
        <defs>
          {/* The body: pearl where the key light meets it, nearly clear on
              the shaded side, catching light again at the far edge. */}
          <linearGradient id={glass} x1="0.08" y1="0" x2="0.92" y2="1">
            <stop offset="0" style={{ stopColor: "var(--rib-glass-a)" }} />
            <stop offset="0.55" style={{ stopColor: "var(--rib-glass-b)" }} />
            <stop offset="1" style={{ stopColor: "var(--rib-glass-a)" }} />
          </linearGradient>
          <linearGradient id={steel} x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0" style={{ stopColor: "var(--rib-hi)" }} />
            <stop offset="0.45" style={{ stopColor: "var(--steel)" }} />
            <stop offset="1" style={{ stopColor: "var(--steel-deep)" }} />
          </linearGradient>
          <linearGradient id={cobalt} x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0" style={{ stopColor: "var(--rib-cobalt-hi)" }} />
            <stop offset="0.5" style={{ stopColor: "var(--cobalt)" }} />
            <stop offset="1" style={{ stopColor: "var(--rib-cobalt-deep)" }} />
          </linearGradient>
          {/* The refraction: the map's own dots, magnified and turned a
              little, seen through the glass. */}
          <pattern id={dots} width="2.6" height="2.6" patternUnits="userSpaceOnUse" patternTransform="rotate(-9 50 50) scale(1.3)">
            <circle cx="1.3" cy="1.3" r="0.48" style={{ fill: "var(--rib-dot)" }} />
          </pattern>
          <radialGradient id={lens} cx="0.42" cy="0.4" r="0.62">
            <stop offset="0.55" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0.15" />
          </radialGradient>
          <mask id={lensMask} maskContentUnits="userSpaceOnUse">
            <rect x="0" y="0" width="100" height="100" fill={`url(#${lens})`} />
          </mask>
          <radialGradient id={bead} cx="0.36" cy="0.32" r="0.72">
            <stop offset="0" style={{ stopColor: "var(--rib-glass-a)" }} />
            <stop offset="0.7" style={{ stopColor: "var(--rib-glass-b)" }} />
            <stop offset="1" style={{ stopColor: "var(--steel)" }} />
          </radialGradient>
          <radialGradient id={beadOk} cx="0.38" cy="0.34" r="0.7">
            <stop offset="0" style={{ stopColor: "var(--rib-cobalt-hi)" }} />
            <stop offset="1" style={{ stopColor: "var(--cobalt)" }} />
          </radialGradient>
          <radialGradient id={shadow}>
            <stop offset="0" style={{ stopColor: "var(--rib-shadow)" }} />
            <stop offset="1" style={{ stopColor: "var(--rib-shadow)", stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient id={sheen} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.7" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={clip}>
            <path d={RIBBON} />
          </clipPath>
        </defs>
        <ellipse cx={C} cy={96} rx={25} ry={2.6} fill={`url(#${shadow})`} className="shadow" />
        <path d={RIBBON} fill={`url(#${glass})`} />
        <path className="dots" d={RIBBON} fill={`url(#${dots})`} mask={`url(#${lensMask})`} />
        <path className="core steel" d={CORE} fill={`url(#${steel})`} />
        <path className="core ok" d={CORE} fill={`url(#${cobalt})`} />
        <path d={BAND} fill="none" className="band" strokeWidth={1.4} strokeLinecap="round" />
        <g clipPath={`url(#${clip})`}>
          <g transform="rotate(18 50 50)">
            <rect className="sweep" x={-40} y={-10} width={36} height={120} fill={`url(#${sheen})`} />
          </g>
        </g>
        <path d={RIBBON} fill="none" className="edge" strokeWidth={1.1} strokeLinejoin="round" />
        <path d={RIBBON} fill="none" className="rim" strokeWidth={0.6} strokeLinejoin="round" />
        <path d={STREAK} fill="none" className="streak" strokeWidth={1.3} strokeLinecap="round" />
        <path d={STREAK_2} fill="none" className="streak" strokeWidth={0.8} strokeLinecap="round" />
        <circle cx={C} cy={C} r={6.4} fill={`url(#${bead})`} className="bead" />
        <circle className="core ok" cx={C} cy={C} r={3.6} fill={`url(#${beadOk})`} />
        <circle cx={C} cy={C} r={6.4} fill="none" className="rim" strokeWidth={0.5} />
        <circle cx={C - 2} cy={C - 2.2} r={1.5} className="glint" />
      </svg>
    </div>
  );
}
