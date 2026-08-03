import { useId } from "react";
import { cn } from "@/lib/utils";

/** The Neoxify mark: a broken ring around a solid centre.
 *
 * Same mark as the website and the desktop app, not a third variant.
 * The panel used to draw a lightning bolt in a rounded square, which
 * the app dropped precisely because it existed nowhere else in the
 * product -- leaving the panel as the last place still showing it.
 *
 * r=21 gives a circumference of ~132, so 96 on / 36 off is exactly one
 * stroke and one gap. Changing the radius means recomputing the dash
 * array or the gap multiplies.
 *
 * The gradient id has to be unique per instance -- two inline SVGs
 * sharing one id means whichever mounted first wins and the other
 * renders black.
 */
export function LogoMark({ className }: { className?: string }) {
  const gradientId = useId();

  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("size-8 shrink-0 drop-shadow-[0_0_12px_var(--primary)]", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <circle
        cx="32"
        cy="32"
        r="21"
        stroke={`url(#${gradientId})`}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray="96 36"
        transform="rotate(-58 32 32)"
      />
      <circle cx="32" cy="32" r="8" fill={`url(#${gradientId})`} />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      {/* Gradient wordmark, matching the site's and the app's treatment
          of the name. bg-clip-text needs a transparent foreground to
          show through. */}
      <span className="bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-base font-semibold tracking-tight text-transparent">
        Neoxify
      </span>
    </div>
  );
}
