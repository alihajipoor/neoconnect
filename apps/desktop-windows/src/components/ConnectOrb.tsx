import { useId } from "react";
import { AlertTriangle, Power } from "lucide-react";
import { cn } from "../lib/utils";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  /** An engine is running but the far end is not answering, so traffic
   * is not actually protected. Its own state because the alternative --
   * folding it into "connected" -- is what told customers they were safe
   * when they were not. */
  | "degraded"
  | "disconnecting";

/** The app's one hero control.
 *
 * This replaces a flat filled circle, which was the single thing the eye
 * landed on and the single thing that made the app look unfinished. The
 * layers, outside in:
 *
 *   1. two expanding rings, only while connected -- the ambient signal
 *      that the tunnel is live, visible from across a desk
 *   2. a soft colour bloom behind the dial
 *   3. an SVG dial: a faint full track, plus a gradient arc that is a
 *      short spinning segment while working and a near-complete ring
 *      once connected
 *   4. a glass button face with a power glyph
 *
 * The arc is drawn with stroke-dasharray on a known circumference rather
 * than by animating a path, so the three states are one number changing
 * and the transition between them interpolates for free.
 */
export function ConnectOrb({
  state,
  disabled,
  onToggle,
  label,
}: {
  state: ConnectionState;
  disabled?: boolean;
  onToggle: () => void;
  label: string;
}) {
  // Two inline SVGs sharing a gradient id means the second renders black,
  // so the id has to be per-instance.
  const gradientId = useId();

  const busy = state === "connecting" || state === "disconnecting";
  const on = state === "connected";
  const degraded = state === "degraded";

  // r=54 in a 128 viewBox -> circumference 339.29. The arc is a quarter
  // while spinning, and 88% once connected (the gap keeps it reading as a
  // dial rather than a plain circle).
  const CIRCUMFERENCE = 2 * Math.PI * 54;
  const dash = busy ? CIRCUMFERENCE * 0.25 : on ? CIRCUMFERENCE * 0.88 : CIRCUMFERENCE * 0.6;

  return (
    <div className="relative flex size-44 items-center justify-center">
      {/* Live-tunnel rings. Staggered so they read as a sequence rather
          than one thick pulse. */}
      {on ? (
        <>
          <span className="animate-ping-ring absolute size-32 rounded-full border border-success/50" />
          <span
            className="animate-ping-ring absolute size-32 rounded-full border border-success/30"
            style={{ animationDelay: "1.4s" }}
          />
        </>
      ) : null}

      {/* Colour bloom. Breathes only while working, so an idle app is
          completely still. */}
      <span
        className={cn(
          "absolute size-28 rounded-full blur-2xl transition-colors duration-500",
          on
            ? "bg-success/35"
            : degraded
              ? "bg-warning/35"
              : busy
                ? "animate-breathe bg-primary/40"
                : "bg-primary/20",
        )}
      />

      <svg viewBox="0 0 128 128" className={cn("absolute size-44", busy && "animate-spin-slow")}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={on ? "#10b981" : degraded ? "#f59e0b" : "#a78bfa"} />
            <stop offset="1" stopColor={degraded ? "#f97316" : "#22d3ee"} />
          </linearGradient>
        </defs>
        <circle cx="64" cy="64" r="54" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="3" />
        <circle
          cx="64"
          cy="64"
          r="54"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
          // Start the arc at 12 o'clock instead of 3 o'clock.
          transform="rotate(-90 64 64)"
          className="transition-[stroke-dasharray] duration-500"
        />
      </svg>

      <button
        onClick={onToggle}
        disabled={disabled || busy}
        aria-label={label}
        className={cn(
          "press relative flex size-28 flex-col items-center justify-center gap-1.5 rounded-full border backdrop-blur-md",
          "disabled:pointer-events-none disabled:opacity-70",
          on
            ? "border-success/40 bg-success/12 text-success shadow-[0_0_50px_-12px_var(--success),inset_0_1px_0_rgba(255,255,255,0.12)]"
            : degraded
              ? "border-warning/45 bg-warning/12 text-warning shadow-[0_0_50px_-12px_var(--warning),inset_0_1px_0_rgba(255,255,255,0.12)]"
              : "border-primary/35 bg-primary/10 text-primary shadow-[0_0_50px_-12px_var(--primary),inset_0_1px_0_rgba(255,255,255,0.12)] hover:bg-primary/16",
        )}
      >
        {degraded ? (
          <AlertTriangle className="size-7" strokeWidth={2.25} />
        ) : (
          <Power className={cn("size-7 transition-transform duration-300", on && "scale-110")} strokeWidth={2.25} />
        )}
        <span className="px-2 text-center text-[11px] leading-tight font-semibold tracking-wide">{label}</span>
      </button>
    </div>
  );
}
