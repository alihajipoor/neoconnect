import Link from "next/link";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { InsightNetworkRef } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VIEWS, customerHref, type CustomerView } from "./insight-format";

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
    <nav aria-label="Customer views" className="flex flex-wrap gap-1 border-b border-white/10">
      {VIEWS.map(({ view, label }) => {
        const active = view === current;
        return (
          <Link
            key={view}
            href={customerHref(customerId, { ...keep, view })}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors max-lg:min-h-10",
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
                "rounded-md px-2.5 py-1 text-xs transition-colors max-lg:py-2",
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
  children,
}: {
  title: React.ReactNode;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">
          {title}
          {note && <span className="ml-2 text-sm font-normal text-muted-foreground">{note}</span>}
        </CardTitle>
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
