import { cn } from "../lib/utils";

/** Signal-strength bars plus the actual number.
 *
 * Both, rather than one or the other: the bars are readable at a glance
 * and mean something to anyone, while the millisecond figure is what a
 * player comparing servers actually wants. Colour follows the bars so the
 * two never disagree.
 *
 * `null` means the measurement did not complete. It renders as "--" with
 * empty bars and is never coloured, because a fabricated number here is
 * the same class of dishonesty as a false "Connected" -- someone would
 * pick a server based on it.
 */
export function Latency({ ms, className }: { ms: number | null; className?: string }) {
  // Thresholds chosen for how a connection actually feels rather than
  // round numbers: under ~80ms is comfortable for real-time use, under
  // ~180ms is usable, beyond that is noticeable lag.
  const bars = ms === null ? 0 : ms < 80 ? 3 : ms < 180 ? 2 : 1;
  const tone =
    ms === null
      ? "text-muted-foreground"
      : bars === 3
        ? "text-success"
        : bars === 2
          ? "text-warning"
          : "text-destructive";

  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", tone, className)}>
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              "w-[3px] rounded-[1px] transition-colors",
              i === 0 ? "h-[5px]" : i === 1 ? "h-[8px]" : "h-[11px]",
              i < bars ? "bg-current" : "bg-current/20",
            )}
          />
        ))}
      </span>
      {/* Kept LTR inside an RTL layout: "23 ms" must not render reversed. */}
      <span className="tabular-nums text-[11px] font-medium" data-ltr>
        {ms === null ? "--" : `${ms} ms`}
      </span>
    </span>
  );
}
