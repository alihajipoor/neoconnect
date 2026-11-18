import Link from "next/link";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { InsightNetworkRef } from "@/lib/types";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VIEWS, customerHref, type CustomerView } from "./insight-format";
import { percent, ratioTone } from "./insight-layout";

/** Small pieces shared by the customer page's four views. Server
 * components only: no state, and plain links so every view works with
 * JavaScript off. */

/** A read that failed, as null -- so each card can say "could not load"
 * instead of showing an empty list that reads as "nothing happened". */
export function orNull<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch(() => null);
}

/** The row of view links under the header. Only the window settings
 * carry over; paging and filters belong to the view they were set on. */
export function ViewTabs({
  customerId,
  current,
  keep,
}: {
  customerId: string;
  current: CustomerView;
  keep: Record<string, string | number | undefined>;
}) {
  return (
    // One row that never wraps into two rows of tabs. On a phone the tabs
    // are tighter so all five fit from 360px, with the active one in view
    // and no script; past that the row scrolls sideways.
    <nav
      aria-label="Customer views"
      className="-mx-1 flex gap-1 overflow-x-auto border-b border-white/10 px-1 whitespace-nowrap [scrollbar-width:none] max-sm:gap-0"
    >
      {VIEWS.map(({ view, label }) => {
        const active = view === current;
        return (
          <Link
            key={view}
            href={customerHref(customerId, { ...keep, view })}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm transition-colors max-lg:flex max-lg:min-h-10 max-lg:items-center max-sm:min-[380px]:px-1.5 max-sm:min-[380px]:text-[13px] max-[379px]:px-1 max-[379px]:text-xs",
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** "24 hours / 7 days / ..." as links, the chosen one marked. */
export function WindowSwitch({
  label,
  options,
  current,
  href,
}: {
  label: string;
  options: readonly { value: number; label: string }[];
  current: number;
  href: (value: number) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1 rounded-lg border border-white/10 p-0.5">
        {options.map((option) => {
          const active = option.value === current;
          return (
            <Link
              key={option.value}
              href={href(option.value)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors max-lg:flex max-lg:min-h-10 max-lg:items-center",
                active ? "bg-white/10 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function Section({
  title,
  note,
  aside,
  children,
}: {
  title: React.ReactNode;
  note?: React.ReactNode;
  /** Small things on the right of the heading (counts, a link). */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-4">
      <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
        <CardTitle className="text-base">
          {title}
          {note && <span className="ml-2 text-sm font-normal text-muted-foreground">{note}</span>}
        </CardTitle>
        {aside && <div className="flex flex-wrap items-center gap-2 text-xs">{aside}</div>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** "3h ago", with the exact time on hover. */
export function When({ at, empty = "—" }: { at: string | null; empty?: string }) {
  if (!at) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span className="whitespace-nowrap" title={new Date(at).toLocaleString()}>
      {ago(at)}
    </span>
  );
}

export function NetworkLabel({ network }: { network: InsightNetworkRef | null }) {
  if (!network) return <span className="text-muted-foreground">unknown network</span>;
  return (
    <span>
      {network.name ?? "Unnamed network"}
      <span className="ml-1.5 font-mono text-xs text-muted-foreground">AS{network.asn}</span>
    </span>
  );
}

/** The box around a table; the shared Table scrolls sideways inside it. */
export function TableBox({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0 rounded-lg border border-white/8 bg-card/40">{children}</div>;
}

/** Colour is for meaning only: red a problem, amber a warning, green
 * healthy; everything else stays neutral. */
export type Tone = "neutral" | "problem" | "warning" | "healthy";

const TILE_TONE: Record<Tone, string> = {
  neutral: "border-white/8",
  problem: "border-destructive/40",
  warning: "border-amber-500/30",
  healthy: "border-white/8",
};
const VALUE_TONE: Record<Tone, string> = {
  neutral: "",
  problem: "text-red-300",
  warning: "text-amber-300",
  healthy: "text-success",
};

/** The grid the answer tiles sit in: two to a row on a phone, four wide. */
export function Tiles({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>{children}</div>;
}

/** One answer: a label, the figure, a line under it and an optional bar. */
export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
  bar,
  wide,
  children,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  /** Part of whole for a thin bar under the figure. */
  bar?: { part: number; whole: number };
  /** Spans the whole row. */
  wide?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border bg-card/40 px-3.5 py-3",
        TILE_TONE[tone],
        wide && "col-span-full",
      )}
    >
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <div className={cn("text-lg leading-tight font-semibold tabular-nums [overflow-wrap:anywhere]", VALUE_TONE[tone])}>
        {value}
      </div>
      {bar && <ShareBar part={bar.part} whole={bar.whole} className="mt-0.5" />}
      {sub && <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{sub}</div>}
      {children}
    </div>
  );
}

/** A thin bar for part of whole. Green when all succeeded, a red track
 * when none did, neutral in between. */
export function ShareBar({ part, whole, className }: { part: number; whole: number; className?: string }) {
  const tone = ratioTone(part, whole);
  const share = percent(part, whole) ?? 0;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full",
        tone === "none" ? "bg-destructive/30" : "bg-white/8",
        className,
      )}
    >
      <div
        className={cn("h-full rounded-full", tone === "all" ? "bg-success/80" : "bg-foreground/55")}
        style={{ width: `${share}%` }}
      />
    </div>
  );
}

/** "6 of 7" with a thin bar under it, for a table cell. A row with tries
 * and no success reads in quiet red; with nothing tried, a dash. */
export function Ratio({ part, whole }: { part: number; whole: number }) {
  const tone = ratioTone(part, whole);
  if (tone === "empty") return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex w-20 max-w-full flex-col gap-1 align-middle sm:items-end">
      <span className={cn("tabular-nums", tone === "none" && "text-red-300")}>
        {part} of {whole}
      </span>
      <ShareBar part={part} whole={whole} />
    </span>
  );
}

/** One column of a chart: its height and the words for it. */
export interface ChartColumn {
  key: string;
  value: number;
  /** What the column is, said in full ("18 Nov 14:00 UTC: 1.2 GB"). */
  label: string;
}

/** A column chart in plain elements. Each column can take focus, so its
 * value shows on hover, on keyboard focus and on a tap. */
export function ColumnChart({
  columns,
  caption,
  start,
  end,
  peak,
}: {
  columns: ChartColumn[];
  caption: string;
  start: string;
  end: string;
  /** The tallest column's value, as text. */
  peak: string;
}) {
  const max = Math.max(0, ...columns.map((c) => c.value));
  return (
    <figure className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>Peak {peak}</span>
        <span className="max-sm:hidden">Hover or tap a column for its value</span>
        <span className="sm:hidden">Tap a column</span>
      </div>
      <ul aria-label={caption} className="flex h-28 items-end gap-px border-b border-white/15">
        {columns.map((column, index) => {
          const height = max > 0 ? (column.value / max) * 100 : 0;
          const right = index > columns.length / 2;
          return (
            <li
              key={column.key}
              tabIndex={0}
              aria-label={column.label}
              title={column.label}
              className="group relative flex h-full min-w-0 flex-1 items-end rounded-t-sm outline-none hover:bg-white/5 focus-visible:bg-white/8 focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span
                className="block w-full rounded-t-sm bg-primary/70 group-hover:bg-primary group-focus:bg-primary"
                style={{ height: column.value > 0 ? `max(${height}%, 2px)` : 0 }}
              />
              <span
                className={cn(
                  "pointer-events-none absolute bottom-full z-10 mb-1 hidden rounded-md border border-white/10 bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md group-hover:block group-focus:block",
                  right ? "right-0" : "left-0",
                )}
              >
                {column.label}
              </span>
            </li>
          );
        })}
      </ul>
      <figcaption className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{start}</span>
        <span>{end}</span>
      </figcaption>
    </figure>
  );
}

/** Long detail folded behind a native disclosure, so a server-rendered
 * view needs no script for it. */
export function More({ summary, children }: { summary: React.ReactNode; children: React.ReactNode }) {
  return (
    <details className="group/more">
      <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-8 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open/more:rotate-90" aria-hidden="true" />
        {summary}
      </summary>
      <div className="mt-2 flex flex-col gap-3">{children}</div>
    </details>
  );
}

/** One line of text, cut to its width; a tap or click shows all of it
 * (a `title` alone never reaches a touch screen). */
export function FoldedText({ text, className }: { text: string; className?: string }) {
  return (
    <details className={cn("group/fold min-w-0", className)}>
      <summary
        title={text}
        className="cursor-pointer list-none truncate group-open/fold:whitespace-pre-wrap group-open/fold:[overflow-wrap:anywhere] [&::-webkit-details-marker]:hidden"
      >
        {text}
      </summary>
    </details>
  );
}
