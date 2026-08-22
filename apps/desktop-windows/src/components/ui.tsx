// Small, dependency-free UI primitives -- deliberately not a full
// shadcn/Radix setup like the panel has. v1 screens (login/register/
// dashboard) don't need dialogs/selects/dropdowns, so pulling in that
// machinery here would be pure overhead. Revisit if a later screen
// (route/plan picker) genuinely needs an overlay component.
import type { ButtonHTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

export function Button({
  className,
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "destructive" | "ghost" | "outline";
}) {
  // `default` is the site's violet-to-cyan gradient rather than a flat
  // fill, and lifts on hover -- a solid rectangle was the single biggest
  // reason the app read as a generic template. The glow uses colour-mix
  // so it stays tied to the token instead of a hardcoded rgba that
  // silently drifts if --primary ever changes.
  const variants = {
    default:
      "bg-[linear-gradient(120deg,var(--primary),color-mix(in_oklab,var(--primary)_55%,var(--highlight)))] text-primary-foreground shadow-[0_4px_16px_-6px_var(--primary)] hover:shadow-[0_8px_26px_-8px_var(--primary)] hover:brightness-110",
    destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    ghost: "bg-transparent text-foreground hover:bg-white/8",
    outline:
      "border border-white/12 bg-white/[0.02] text-foreground hover:border-white/20 hover:bg-white/6",
  };
  return (
    <button
      className={cn(
        "press inline-flex h-9 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-input bg-white/[0.03] px-3 text-sm outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground hover:border-white/16 focus-visible:border-ring focus-visible:bg-white/[0.05] focus-visible:ring-[3px] focus-visible:ring-ring/25",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium text-foreground", className)} {...props} />;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // The top hairline is what separates a "surface" from a "box with a
  // border": it reads as light catching an edge, which is the treatment
  // the website uses on its own cards.
  // shrink-0 matters more than it looks. A flex item shrinks by default,
  // and these sit in scrolling flex columns, so once the content is
  // taller than the window every card gets squeezed -- and because of
  // the overflow-hidden below, whatever ends up past the new shorter
  // edge is simply clipped away rather than scrolled to.
  //
  // That silently ate the Crypto and Card buttons on the plans screen as
  // soon as a second plan existed: the cards rendered 65px shorter than
  // their content and the buttons sat 50px below the visible edge, still
  // in the DOM, invisible and unclickable. It looked like the buttons
  // were missing rather than like a layout problem, and it came and went
  // with the number of plans. A card should be its content's height and
  // let the container scroll.
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-xl border border-white/10 bg-card/70 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-16px_rgba(0,0,0,0.9)] backdrop-blur-sm",
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/15 before:to-transparent",
        className,
      )}
      {...props}
    />
  );
}

/** A labelled figure -- the app's unit of "one fact worth glancing at".
 *
 * Exists so the Dashboard's stat row is one component repeated rather
 * than three hand-built divs that drift apart, and so any later screen
 * showing a metric gets the same treatment for free.
 */
/** A labelled fact about the connection, optionally the control that
 * changes it.
 *
 * `onClick` is what fixes a real and repeated support problem: these
 * tiles carry `surface-interactive`, so they highlight under the cursor
 * and read as buttons, while the actual "change server" control sat
 * further down the page showing the very same value. Customers tapped
 * the tile, nothing happened, and they reported the app as broken --
 * reasonably, because a thing that lights up when you point at it has
 * promised something.
 *
 * So a tile that shows a changeable fact now *is* the control, with a
 * chevron and an action word to say so out loud rather than relying on
 * the hover state alone. A tile with no `onClick` stays a plain div and
 * loses the interactive styling, so nothing lights up that cannot be
 * pressed. */
export function Stat({
  icon,
  label,
  value,
  className,
  onClick,
  actionLabel,
  disabledReason,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  className?: string;
  onClick?: () => void;
  /** Shown next to the chevron -- "Change", "Pick". */
  actionLabel?: string;
  /** When set, the tile is inert and this explains why. Saying it beats
   * a dead control: an unexplained disabled button is the same dead end
   * as a fake one. */
  disabledReason?: string;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="flex items-center justify-between gap-1">
        <span className="truncate text-xs leading-tight font-semibold text-foreground">{value}</span>
        {onClick && !disabledReason ? (
          // Deliberately a size below the caption above it. Three of
          // these fit across a 400px window, and set at the same 10px
          // the action took enough of the row that the value -- the
          // fact the tile exists to show -- was what truncated: a
          // customer on fi-finland read "fi-finl...". Shrinking the
          // word that never changes buys back the room for the one
          // that does, and the tile's violet fill and border were
          // always the louder half of "this is pressable" anyway.
          <span className="flex shrink-0 items-center gap-px text-[9px] font-semibold text-primary">
            {actionLabel}
            {/* Mirrored under Persian: a chevron means "onward", and
                onward is leftward in an RTL layout. */}
            <ChevronRight className="size-2.5 rtl:rotate-180" />
          </span>
        ) : null}
      </span>
    </>
  );

  const shell = "flex min-w-0 flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-start";

  if (!onClick) {
    return (
      <div className={cn(shell, "border-white/8 bg-white/[0.025]", className)}>{body}</div>
    );
  }

  return (
    <button
      type="button"
      onClick={disabledReason ? undefined : onClick}
      disabled={Boolean(disabledReason)}
      title={disabledReason}
      aria-label={disabledReason ? `${label}: ${disabledReason}` : undefined}
      className={cn(
        shell,
        // A brighter border and the primary ring on hover, because this
        // one really is pressable -- the difference from a plain tile has
        // to be visible before the press, not after.
        "surface-interactive border-primary/25 bg-primary/[0.06] transition-colors",
        "hover:border-primary/50 hover:bg-primary/10",
        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:border-white/8 disabled:bg-white/[0.025] disabled:opacity-70",
        className,
      )}
    >
      {body}
    </button>
  );
}
