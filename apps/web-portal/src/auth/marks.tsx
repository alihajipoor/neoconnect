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

/* --- Sign-in providers ----------------------------------------------------
   The marks as each brand publishes them, the same paths as the apps'
   BrandIcons.tsx (apps/desktop-windows/src/components). Both brands set
   binding rules for them:

   - Google's "G" is never recoloured: its four colours are the mark, on
     a light button or a dark one alike.
   - Facebook's "f" logo is the blue circle with the "f" in white. The
     apps draw the circle in currentColor with the "f" cut out, which on
     a dark card shows the card through it; here a white disc sits
     behind, so the "f" is white on either. Never the blue on a coloured
     button, never another blue.

   Fill attributes, not style attributes: the page's style-src has
   nothing to refuse. Decorative, since the button says the name. */

export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path
        fill="#4285F4"
        d="M23.52 12.273c0-.851-.076-1.67-.218-2.455H12v4.642h6.458a5.52 5.52 0 0 1-2.396 3.622v3.01h3.878c2.269-2.089 3.58-5.165 3.58-8.819"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.956-1.075 7.94-2.908l-3.877-3.01c-1.075.72-2.45 1.145-4.063 1.145-3.126 0-5.772-2.111-6.716-4.948H1.276v3.109A11.995 11.995 0 0 0 12 24"
      />
      <path
        fill="#FBBC05"
        d="M5.284 14.279A7.212 7.212 0 0 1 4.909 12c0-.791.136-1.56.375-2.279V6.612H1.276A11.995 11.995 0 0 0 0 12c0 1.937.464 3.769 1.276 5.388l4.008-3.109Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.773c1.762 0 3.344.605 4.587 1.794l3.442-3.442C17.951 1.19 15.235 0 12 0 7.31 0 3.255 2.689 1.276 6.612l4.008 3.109C6.228 6.884 8.874 4.773 12 4.773"
      />
    </svg>
  );
}

const FACEBOOK_BLUE = "#0866FF";

export function FacebookMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <circle cx="12" cy="12.073" r="11.8" fill="#ffffff" />
      <path
        fill={FACEBOOK_BLUE}
        d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073"
      />
    </svg>
  );
}
