import { useId } from "react";
import glassLight from "./neoxify-glass-light.svg";
import glassDark from "./neoxify-glass-dark.svg";

/**
 * The Neoxify mark twice over: flat in the header, and as glass beside
 * the card (the app's GlassLogo, below).
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

/* The glass version: the app's own GlassLogo (apps/desktop-windows/src/
   components/main/GlassLogo.tsx) -- LogoMark's exact shape as a glass
   object in the brand's violet-to-cyan -- rendered once from the app and
   kept here as two static SVGs, pearl and smoked. The owner asked for the
   logo itself here (2026-10-19, and again for the website 2026-10-22), in
   place of the twisted ribbon that stood in for it.

   Presentation attributes only, no style attributes, so the page's
   style-src policy has nothing to refuse. Static: there is no connection
   to show before sign-in, so nothing about it moves. */

export function GlassMark({ className }: { className?: string }) {
  return (
    <picture>
      <source srcSet={glassDark} media="(prefers-color-scheme: dark)" />
      <img src={glassLight} alt="" aria-hidden="true" className={className} decoding="async" />
    </picture>
  );
}
