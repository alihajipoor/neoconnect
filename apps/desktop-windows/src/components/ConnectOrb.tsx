import { useId } from "react";
import { AlertTriangle, HelpCircle, Power } from "lucide-react";
import { cn } from "../lib/utils";

export type ConnectionState =
  | "disconnected"
  /** The helper service could not be asked, so nothing is known about
   * the tunnel. Its own state because the only alternative is to guess,
   * and guessing "disconnected" is the guess that gets somebody hurt:
   * the app showed "You're not protected" and a Connect button while
   * the browser beside it was going out through the node's exit
   * address. Not being able to ask is reported as not knowing. */
  | "unknown"
  | "connecting"
  /** The engine is up and we are establishing whether traffic actually
   * flows. Its own state because the answer is genuinely not known yet,
   * and the two neighbouring states both assert something false:
   * "connected" would be the original lie, and "degraded" alarms a
   * customer about a connection that is merely still negotiating. */
  | "verifying"
  | "connected"
  /** An engine is up, nothing has come back negative, and no check has
   * come back positive either.
   *
   * Its own state because both neighbours assert something the app has
   * not measured. "connected" is the original lie in its purest form:
   * for Xray, OpenVPN and IKEv2 the service reports `unknown` health for
   * as long as the process is alive, and folding that into "connected"
   * meant a customer in Custom mode could sit on a green orb
   * indefinitely while nothing flowed. "degraded" is the same invention
   * pointed the other way, and it is not the harmless direction: a
   * customer in Iran who is told they are unprotected may disconnect and
   * expose themselves, so a check that merely abstained must not be
   * allowed to say it.
   *
   * Rendered in the brand cyan rather than in green or amber, which is
   * the whole point of giving it a colour of its own: it must not be
   * mistaken across a room for either answer. */
  | "unverified"
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

  const busy = state === "connecting" || state === "disconnecting" || state === "verifying";
  const on = state === "connected";
  const degraded = state === "degraded";
  // Up, but nothing has confirmed traffic is flowing. Deliberately given
  // neither the success rings nor the warning triangle: the rings are
  // the claim being withheld, and the triangle is the opposite claim.
  const unconfirmed = state === "unverified";
  // Rendered in grey rather than in the idle violet. The idle orb reads
  // as "press me to connect", which is a claim about the tunnel being
  // down, and that is precisely the claim this state exists to withhold.
  const unsure = state === "unknown";

  // r=54 in a 128 viewBox -> circumference 339.29. The arc is a quarter
  // while spinning, and 88% once connected (the gap keeps it reading as a
  // dial rather than a plain circle).
  // The arc length is itself a statement, so `unverified` gets its own:
  // shorter than a confirmed connection, longer than an idle app. A
  // dial that is nearly closed reads as "done", which is precisely what
  // has not been established.
  const CIRCUMFERENCE = 2 * Math.PI * 54;
  const dash = busy
    ? CIRCUMFERENCE * 0.25
    : on
      ? CIRCUMFERENCE * 0.88
      : unconfirmed
        ? CIRCUMFERENCE * 0.72
        : CIRCUMFERENCE * 0.6;

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
              : unconfirmed
                ? "bg-highlight/30"
                : unsure
                  ? "animate-breathe bg-muted-foreground/25"
                  : busy
                    ? "animate-breathe bg-primary/40"
                    : "bg-primary/20",
        )}
      />

      <svg viewBox="0 0 128 128" className={cn("absolute size-44", busy && "animate-spin-slow")}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop
              offset="0"
              stopColor={
                on
                  ? "#10b981"
                  : degraded
                    ? "#f59e0b"
                    : unsure
                      ? "#94a3b8"
                      : unconfirmed
                        ? "#22d3ee"
                        : "#a78bfa"
              }
            />
            <stop offset="1" stopColor={degraded ? "#f97316" : unsure ? "#64748b" : "#22d3ee"} />
          </linearGradient>
        </defs>
        {/* The track was faint enough to disappear against the wash, so
            the dial read as a floating arc with nothing to measure it
            against -- the gap is what makes it a dial. */}
        <circle cx="64" cy="64" r="54" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3.5" />
        <circle
          cx="64"
          cy="64"
          r="54"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
          // Start the arc at 12 o'clock instead of 3 o'clock.
          transform="rotate(-90 64 64)"
          className="transition-[stroke-dasharray] duration-500"
        />
      </svg>

      <button
        onClick={onToggle}
        // Deliberately NOT disabled by any state of its own. A failover
        // pass can take tens of seconds, and disabling the only control
        // for its duration left no way to stop it -- reported from real
        // use by someone who had to kill the app from Task Manager. An
        // action the customer cannot cancel is worse than one that
        // fails.
        //
        // "disconnecting" used to be the one exception, and it is how
        // that same kill-from-Task-Manager ending came back: a
        // vpn_disconnect that never answered left the state stuck, the
        // stuck state left the button dead, and there was no press that
        // could undo either. A control that can wedge is not a control.
        disabled={disabled}
        aria-label={label}
        className={cn(
          "press relative flex size-28 flex-col items-center justify-center gap-1.5 rounded-full border backdrop-blur-md",
          "disabled:pointer-events-none disabled:opacity-70",
          // Each face carries a lit top edge and a shaded lower half.
          // With only the top hairline the disc read as a flat tinted
          // circle, which is the look the layered dial around it was
          // added to get away from; the two inset shadows together are
          // what make it a piece of glass catching light.
          on
            ? "border-success/40 bg-success/12 text-success shadow-[0_0_50px_-12px_var(--success),inset_0_1px_0_rgba(255,255,255,0.14),inset_0_-14px_28px_-14px_rgba(0,0,0,0.55)]"
            : degraded
              ? "border-warning/45 bg-warning/12 text-warning shadow-[0_0_50px_-12px_var(--warning),inset_0_1px_0_rgba(255,255,255,0.14),inset_0_-14px_28px_-14px_rgba(0,0,0,0.55)]"
              : unconfirmed
                ? "border-highlight/40 bg-highlight/10 text-highlight shadow-[0_0_50px_-16px_var(--highlight),inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-14px_28px_-14px_rgba(0,0,0,0.5)]"
                : unsure
                ? "border-white/15 bg-white/5 text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-14px_28px_-14px_rgba(0,0,0,0.45)] hover:bg-white/8"
                : "border-primary/35 bg-primary/10 text-primary shadow-[0_0_50px_-12px_var(--primary),inset_0_1px_0_rgba(255,255,255,0.14),inset_0_-14px_28px_-14px_rgba(0,0,0,0.55)] hover:bg-primary/16",
        )}
      >
        {degraded ? (
          <AlertTriangle className="size-7" strokeWidth={2.25} />
        ) : unsure ? (
          <HelpCircle className="size-7" strokeWidth={2.25} />
        ) : (
          <Power className={cn("size-7 transition-transform duration-300", on && "scale-110")} strokeWidth={2.25} />
        )}
        <span className="px-2 text-center text-xs leading-tight font-semibold tracking-wide">{label}</span>
      </button>
    </div>
  );
}
