import { useId } from "react";
import { LOGO, arcPath, type LogoTone } from "../../lib/logo-geometry";

/** The Neoxify mark over the world map, as a glass object (owner,
 * 2026-10-19: "our logo there, with the same size and colour tone", in
 * place of the twisted glass ribbon, which did not read as the logo).
 *
 * Exactly LogoMark's geometry (lib/logo-geometry.ts): on a 64-unit square,
 * a ring of radius 21 and width 7 with round caps, dashed 96/36 and turned
 * -58 degrees so its opening sits at the top, around a solid centre of
 * radius 8 -- in the logo's own violet-to-cyan by default, or the app's
 * cobalt (`tone`; pearl.css maps the two colours). The glass is all
 * gradients and thin strokes, no filter and no WebGL, so it costs one
 * static paint:
 *  - a soft contact shadow and the colour the glass throws on the ground,
 *    on a layer of their own so the mark can float above them;
 *  - its thickness: the same shapes a step down and to the right, deeper;
 *  - the body in the logo's gradient inside a hairline and a lit rim;
 *  - shading across the ring's width (lit inside, deeper at the outer
 *    edge), the key light from the top left, specular streaks along the
 *    lit edges, a caustic on the far inner edge and a bead's highlight on
 *    the centre;
 *  - a frost and an inner glow, both driven by the calm tone in CSS: the
 *    colour is a little frosted until the tunnel is verified, then clears
 *    and lights from inside over 900ms, held through a brief gap like the
 *    chip -- never for "Connected, not confirmed".
 * A light sweep crosses it while a connect, check or disconnect is under
 * way (`data-busy`), static under reduced motion. Decorative throughout:
 * `aria-hidden`, and it says nothing the chip does not. Not mirrored in
 * RTL: it is the logo, and the light comes from the top left. */

const { view: V, centre: C } = LOGO;
const { r: R, width: W, dash, rotate } = LOGO.ring;
const DOT = LOGO.dot.r;

/** The ring exactly as LogoMark draws it; every ring layer is this circle
 * with its own stroke. */
const RING = {
  cx: C,
  cy: C,
  r: R,
  fill: "none",
  strokeLinecap: "round" as const,
  strokeDasharray: `${dash[0]} ${dash[1]}`,
  transform: `rotate(${rotate} ${C} ${C})`,
};
/** A screen-space gradient on the turned ring: turned back. */
const UNTURN = `rotate(${-rotate} ${C} ${C})`;

/** Highlights along the lit edges, in screen degrees (the ring covers 302
 * through 360 to 204, its round caps a little past each end). */
const OUTER = R + W / 2 - 1.3;
const INNER = R - W / 2 + 1.3;
const SPEC_LEFT = arcPath(OUTER, 156, 200);
const SPEC_LEFT_TAIL = arcPath(OUTER, 124, 152);
const SPEC_TOP = arcPath(OUTER, 307, 338);
const CAUSTIC = arcPath(INNER, 18, 78);
const BEAD_CAUSTIC = (() => {
  const r = DOT - 2.4;
  const p = (deg: number) => [C + r * Math.cos((deg * Math.PI) / 180), C + r * Math.sin((deg * Math.PI) / 180)].map((v) => v.toFixed(2)).join(" ");
  return `M${p(14)}A${r} ${r} 0 0 1 ${p(82)}`;
})();

export interface GlassLogoProps {
  x: number;
  y: number;
  /** The square it is drawn in, in pixels: the size the ribbon had. */
  size: number;
  /** About 20 s of float after the first verified connect of a session. */
  float?: boolean;
  tone?: LogoTone;
}

export function GlassLogo({ x, y, size, float = false, tone = "brand" }: GlassLogoProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const body = `${id}b`;
  const deep = `${id}d`;
  const tube = `${id}t`;
  const keyRing = `${id}k`;
  const keyDot = `${id}q`;
  const bead = `${id}e`;
  const glow = `${id}g`;
  const ground = `${id}h`;
  const cast = `${id}c`;
  const rimRing = `${id}r`;
  const rimDot = `${id}o`;
  const sheen = `${id}s`;
  const shape = `${id}m`;
  return (
    <div
      className="nx-mark"
      aria-hidden
      data-tone={tone}
      data-float={float ? "1" : undefined}
      style={{ left: x, top: y, width: size, height: size }}
    >
      <svg className="ground" viewBox={`0 0 ${V} ${V}`} focusable="false">
        <defs>
          <radialGradient id={ground}>
            <stop offset="0" style={{ stopColor: "var(--mark-shadow)" }} />
            <stop offset="1" style={{ stopColor: "var(--mark-shadow)", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id={cast}>
            <stop offset="0" style={{ stopColor: "var(--mark-b)" }} />
            <stop offset="1" style={{ stopColor: "var(--mark-b)", stopOpacity: 0 }} />
          </radialGradient>
        </defs>
        <ellipse cx={C} cy={59.6} rx={19} ry={2.7} fill={`url(#${ground})`} />
        {/* The colour the glass throws on the ground. */}
        <ellipse className="cast" cx={C + 1.5} cy={59.3} rx={13} ry={1.9} fill={`url(#${cast})`} />
      </svg>
      <svg className="body" viewBox={`0 0 ${V} ${V}`} focusable="false" data-logo="neoxify">
        <defs>
          {/* LogoMark's gradient: the bounding box's diagonal, turned with
              the ring, so the opening's two ends are violet and cyan. */}
          <linearGradient id={body} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--mark-a)" }} />
            <stop offset="1" style={{ stopColor: "var(--mark-b)" }} />
          </linearGradient>
          <linearGradient id={deep} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--mark-a-deep)" }} />
            <stop offset="1" style={{ stopColor: "var(--mark-b-deep)" }} />
          </linearGradient>
          {/* Across the ring's width: lit at the inner edge, deeper at the
              outer one, so it reads as a rounded glass tube. */}
          <radialGradient id={tube} gradientUnits="userSpaceOnUse" cx={C} cy={C} r={R + W / 2}>
            <stop offset={((R - W / 2) / (R + W / 2)).toFixed(3)} stopColor="#fff" stopOpacity="0.3" />
            <stop offset={((R - 1.2) / (R + W / 2)).toFixed(3)} stopColor="#fff" stopOpacity="0" />
            <stop offset={((R + 1.5) / (R + W / 2)).toFixed(3)} style={{ stopColor: "var(--mark-shade)", stopOpacity: 0 }} />
            <stop offset="1" style={{ stopColor: "var(--mark-shade)", stopOpacity: 0.32 }} />
          </radialGradient>
          {/* The key light, top left to bottom right, in screen space: once
              for the turned ring, once for the centre. */}
          {[keyRing, keyDot].map((k) => (
            <linearGradient
              key={k}
              id={k}
              gradientUnits="userSpaceOnUse"
              x1={C - 22}
              y1={C - 22}
              x2={C + 22}
              y2={C + 22}
              gradientTransform={k === keyRing ? UNTURN : undefined}
            >
              <stop offset="0" stopColor="#fff" stopOpacity="0.24" />
              <stop offset="0.46" stopColor="#fff" stopOpacity="0" />
              <stop offset="0.6" style={{ stopColor: "var(--mark-shade)", stopOpacity: 0 }} />
              <stop offset="1" style={{ stopColor: "var(--mark-shade)", stopOpacity: 0.24 }} />
            </linearGradient>
          ))}
          {/* The lit rim: bright where the key light meets the edge, gone
              on the far side -- an edge catching light, not an outline. */}
          {[rimRing, rimDot].map((k) => (
            <linearGradient
              key={k}
              id={k}
              gradientUnits="userSpaceOnUse"
              x1={C - 24}
              y1={C - 24}
              x2={C + 20}
              y2={C + 20}
              gradientTransform={k === rimRing ? UNTURN : undefined}
            >
              <stop offset="0" style={{ stopColor: "var(--mark-rim)" }} />
              <stop offset="0.5" style={{ stopColor: "var(--mark-rim)", stopOpacity: 0.3 }} />
              <stop offset="0.85" style={{ stopColor: "var(--mark-rim)", stopOpacity: 0 }} />
            </linearGradient>
          ))}
          <radialGradient id={bead} cx="0.36" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#fff" stopOpacity="0.5" />
            <stop offset="0.42" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.72" style={{ stopColor: "var(--mark-shade)", stopOpacity: 0 }} />
            <stop offset="1" style={{ stopColor: "var(--mark-shade)", stopOpacity: 0.3 }} />
          </radialGradient>
          <radialGradient id={glow} gradientUnits="userSpaceOnUse" cx={C} cy={C} r={31}>
            <stop offset="0" style={{ stopColor: "var(--mark-b)", stopOpacity: 0.32 }} />
            <stop offset="0.55" style={{ stopColor: "var(--mark-a)", stopOpacity: 0.16 }} />
            <stop offset="1" style={{ stopColor: "var(--mark-a)", stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient id={sheen} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.75" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          {/* The mark's own shape, for the sweep: a mask, because a clip
              path cannot follow a stroke. */}
          <mask id={shape} maskUnits="userSpaceOnUse" x="0" y="0" width={V} height={V}>
            <circle {...RING} stroke="#fff" strokeWidth={W} />
            <circle cx={C} cy={C} r={DOT} fill="#fff" />
          </mask>
        </defs>

        <circle className="glow" cx={C} cy={C} r={31} fill={`url(#${glow})`} />

        {/* Its thickness. */}
        <g className="depth" transform="translate(0.9 1.7)">
          <circle {...RING} stroke={`url(#${deep})`} strokeWidth={W} />
          <circle cx={C} cy={C} r={DOT} fill={`url(#${deep})`} />
        </g>

        {/* The silhouette: a hairline, the lit rim, then the body. */}
        <circle {...RING} className="edge-ring" strokeWidth={W + 1} />
        <circle className="edge-dot" cx={C} cy={C} r={DOT + 0.5} />
        <circle {...RING} stroke={`url(#${rimRing})`} strokeWidth={W + 0.7} />
        <circle cx={C} cy={C} r={DOT + 0.35} fill={`url(#${rimDot})`} />
        <circle {...RING} className="logo-ring" stroke={`url(#${body})`} strokeWidth={W} />
        <circle className="logo-dot" cx={C} cy={C} r={DOT} fill={`url(#${body})`} />

        {/* Frosted until verified (CSS clears it). */}
        <circle {...RING} className="frost-ring" strokeWidth={W} />
        <circle className="frost-dot" cx={C} cy={C} r={DOT} />

        {/* The glass: shading across the ring, the key light, the bead. */}
        <circle {...RING} stroke={`url(#${tube})`} strokeWidth={W} />
        <circle {...RING} stroke={`url(#${keyRing})`} strokeWidth={W} />
        <circle cx={C} cy={C} r={DOT} fill={`url(#${keyDot})`} />
        <circle cx={C} cy={C} r={DOT} fill={`url(#${bead})`} />

        {/* Lit from inside once verified (CSS fades it in). */}
        <circle {...RING} className="core-ring" strokeWidth={4.6} />
        <circle {...RING} className="core-ring" strokeWidth={2.2} />
        <circle className="core-dot" cx={C} cy={C} r={4.2} />
        <circle className="core-dot" cx={C} cy={C} r={2.4} />

        {/* Speculars along the lit edges, the caustics, the glint. */}
        <path className="spec" d={SPEC_LEFT} strokeWidth={1.25} />
        <path className="spec faint" d={SPEC_LEFT_TAIL} strokeWidth={0.8} />
        <path className="spec faint" d={SPEC_TOP} strokeWidth={1} />
        <path className="caustic" d={CAUSTIC} strokeWidth={1.1} />
        <path className="caustic" d={BEAD_CAUSTIC} strokeWidth={1} />
        <ellipse className="glint" cx={C - 2.6} cy={C - 3.3} rx={2.5} ry={1.5} transform={`rotate(-36 ${C - 2.6} ${C - 3.3})`} />

        <g mask={`url(#${shape})`}>
          <g transform={`rotate(18 ${C} ${C})`}>
            <rect className="sweep" x={-26} y={-10} width={22} height={V + 20} fill={`url(#${sheen})`} />
          </g>
        </g>
      </svg>
    </div>
  );
}
