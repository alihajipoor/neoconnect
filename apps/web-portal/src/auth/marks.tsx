import { useId } from "react";

/**
 * The Neoxify mark twice over: flat in the header, and as glass beside
 * the card.
 *
 * Both are the shape of LogoMark in apps/desktop-windows/src/components/
 * Logo.tsx -- a broken ring around a solid centre, the gap across the
 * top -- in its violet-to-cyan. They are drawn here rather than imported
 * because the shared LogoMark carries the old dark theme's violet glow,
 * which reads as a smudge on pearl.
 *
 * Decorative: `aria-hidden`. The wordmark beside the flat one is the
 * accessible name of the home link.
 */

const BRAND_A = "#8b5cf6";
const BRAND_B = "#22d3ee";

/** The flat mark, exactly LogoMark's geometry: r=21 is a circumference
 * of ~132, so 96 on and 36 off is one stroke and one gap. */
export function BrandMark({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false" className={className}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={BRAND_A} />
          <stop offset="1" stopColor={BRAND_B} />
        </linearGradient>
      </defs>
      <circle
        cx="32"
        cy="32"
        r="21"
        stroke={`url(#${id}b)`}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray="96 36"
        transform="rotate(-58 32 32)"
      />
      <circle cx="32" cy="32" r="8" fill={`url(#${id}b)`} />
    </svg>
  );
}

/* The glass version: the app's sculpture (design-system.md 5.1, the
   vector stand-in in the redesign's Sculpture.tsx) -- a ribbon with a lens
   cross-section that twists by half a turn along the arc -- with the
   brand's violet-to-cyan as the colour it carries inside. Static: it has
   no state to show before sign-in, so nothing about it moves. */

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

function ribbonPath(k = 1): string {
  const steps = 48;
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

export function GlassMark({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  const glass = `${id}g`;
  const brand = `${id}c`;
  const dots = `${id}d`;
  const lens = `${id}l`;
  const lensMask = `${id}n`;
  const bead = `${id}b`;
  const shadow = `${id}h`;
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" className={className}>
      <defs>
        {/* The body: pearl where the key light meets it, nearly clear on
            the shaded side, catching light again at the far edge. */}
        <linearGradient id={glass} x1="0.08" y1="0" x2="0.92" y2="1">
          <stop offset="0" className="pa-gm-glass-a" />
          <stop offset="0.55" className="pa-gm-glass-b" />
          <stop offset="1" className="pa-gm-glass-a" />
        </linearGradient>
        <linearGradient id={brand} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor={BRAND_A} />
          <stop offset="1" stopColor={BRAND_B} />
        </linearGradient>
        {/* The refraction: the map's own dots, magnified and turned a
            little, seen through the glass. */}
        <pattern id={dots} width="2.6" height="2.6" patternUnits="userSpaceOnUse" patternTransform="rotate(-9 50 50) scale(1.3)">
          <circle cx="1.3" cy="1.3" r="0.48" className="pa-gm-dot" />
        </pattern>
        <radialGradient id={lens} cx="0.42" cy="0.4" r="0.62">
          <stop offset="0.55" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.15" />
        </radialGradient>
        <mask id={lensMask} maskContentUnits="userSpaceOnUse">
          <rect x="0" y="0" width="100" height="100" fill={`url(#${lens})`} />
        </mask>
        <radialGradient id={bead} cx="0.36" cy="0.32" r="0.72">
          <stop offset="0" className="pa-gm-glass-a" />
          <stop offset="1" className="pa-gm-glass-b" />
        </radialGradient>
        <radialGradient id={shadow}>
          <stop offset="0" className="pa-gm-shadow" />
          <stop offset="1" className="pa-gm-shadow" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx={C} cy={96} rx={25} ry={2.6} fill={`url(#${shadow})`} className="pa-gm-floor" />
      <path d={RIBBON} fill={`url(#${glass})`} />
      <path d={RIBBON} fill={`url(#${dots})`} mask={`url(#${lensMask})`} className="pa-gm-refract" />
      <path d={CORE} fill={`url(#${brand})`} className="pa-gm-core" />
      <path d={BAND} fill="none" stroke={`url(#${brand})`} strokeWidth={1.4} strokeLinecap="round" className="pa-gm-band" />
      <path d={RIBBON} fill="none" strokeWidth={1.1} strokeLinejoin="round" className="pa-gm-edge" />
      <path d={RIBBON} fill="none" strokeWidth={0.6} strokeLinejoin="round" className="pa-gm-rim" />
      <path d={STREAK} fill="none" strokeWidth={1.3} strokeLinecap="round" className="pa-gm-streak" />
      <path d={STREAK_2} fill="none" strokeWidth={0.8} strokeLinecap="round" className="pa-gm-streak" />
      <circle cx={C} cy={C} r={6.4} fill={`url(#${bead})`} />
      <circle cx={C} cy={C} r={3.6} fill={`url(#${brand})`} className="pa-gm-core" />
      <circle cx={C} cy={C} r={6.4} fill="none" strokeWidth={0.5} className="pa-gm-rim" />
      <circle cx={C - 2} cy={C - 2.2} r={1.5} className="pa-gm-glint" />
    </svg>
  );
}
