// Small, dependency-free UI primitives -- deliberately not a full
// shadcn/Radix setup like the panel has. v1 screens (login/register/
// dashboard) don't need dialogs/selects/dropdowns, so pulling in that
// machinery here would be pure overhead. Revisit if a later screen
// (route/plan picker) genuinely needs an overlay component.
import type { ButtonHTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes } from "react";
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
export function Stat({
  icon,
  label,
  value,
  className,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "surface-interactive flex min-w-0 flex-col gap-1 rounded-lg border border-white/8 bg-white/[0.025] px-2.5 py-2",
        className,
      )}
    >
      <span className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="truncate text-xs font-semibold text-foreground">{value}</span>
    </div>
  );
}
