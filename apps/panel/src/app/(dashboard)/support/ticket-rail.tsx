"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Inbox, Search } from "lucide-react";
import type { SupportTicketListRow, SupportTicketStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

const FILTERS: { value: SupportTicketStatus | "ALL"; label: string }[] = [
  { value: "OPEN", label: "Needs reply" },
  { value: "ANSWERED", label: "Answered" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "ALL", label: "All" },
];

/** One status's worth of the inbox: the rows that were loaded, and how
 * many exist behind them.
 *
 * `total` comes from the API's `X-Total-Count` and is a count of the
 * status, not of `items`. The two are different numbers as soon as a
 * status has more conversations than one window holds, and the badge
 * this rail draws is the one an operator reads as "how many people are
 * waiting" -- so it has to be the former. It used to be
 * `tickets.filter(...).length` over whatever array the layout had
 * fetched, which is the page size wearing a total's clothes. */
export interface TicketBucket {
  items: SupportTicketListRow[];
  total: number;
}

/** Defaults to "Needs reply" rather than "All".
 *
 * An inbox that opens on everything makes the operator do the triage a
 * status column already did for them. The one view that matters on
 * opening this page is the set of people still waiting.
 *
 * Each tab is its own server-filtered page (see the layout for why they
 * all arrive together rather than being fetched on click), so switching
 * tabs picks between lists the database built and never re-filters one
 * list into three.
 */
export function TicketRail({ buckets }: { buckets: Record<SupportTicketStatus, TicketBucket> }) {
  const pathname = usePathname();
  const [filter, setFilter] = useState<SupportTicketStatus | "ALL">("OPEN");
  const [query, setQuery] = useState("");

  // "All" is the three pages back to back rather than a fourth request:
  // the API orders an unfiltered list by status first and last activity
  // second, and the enum is declared OPEN, ANSWERED, RESOLVED -- so
  // concatenating them in that order reproduces exactly what it would
  // have returned, and the totals sum to the inbox's own.
  const bucket: TicketBucket =
    filter === "ALL"
      ? {
          items: [...buckets.OPEN.items, ...buckets.ANSWERED.items, ...buckets.RESOLVED.items],
          total: buckets.OPEN.total + buckets.ANSWERED.total + buckets.RESOLVED.total,
        }
      : buckets[filter];

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? bucket.items.filter(
        (ticket) =>
          ticket.subject.toLowerCase().includes(needle) ||
          ticket.customer.email.toLowerCase().includes(needle),
      )
    : bucket.items;

  const openCount = buckets.OPEN.total;
  const loadedShort = bucket.total > bucket.items.length;

  return (
    <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
      <div className="relative">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search subject or email"
          className="pl-9"
        />
      </div>

      <div className="flex gap-1 overflow-x-auto">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
              filter === option.value
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
            )}
          >
            {option.label}
            {option.value === "OPEN" && openCount > 0 && (
              <span className="ml-1.5 rounded-full bg-primary/25 px-1.5 py-0.5 text-[10px] text-foreground tabular-nums">
                {openCount.toLocaleString()}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5 overflow-y-auto lg:max-h-[calc(100vh-19rem)]">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-white/8 bg-card/40 px-4 py-10 text-center">
            <Inbox className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {bucket.total === 0 ? "Nothing here." : "Nothing matches."}
            </p>
          </div>
        ) : (
          visible.map((ticket) => {
            const active = pathname === `/support/${ticket.id}`;
            return (
              <Link
                key={ticket.id}
                href={`/support/${ticket.id}`}
                className={cn(
                  "flex flex-col gap-1 rounded-lg border px-3 py-2.5 transition-colors",
                  active
                    ? "border-primary/40 bg-primary/10"
                    : "border-white/8 bg-card/40 hover:border-white/15 hover:bg-card/70",
                )}
              >
                <div className="flex items-start gap-2">
                  {/* A dot, not a badge: the only status worth interrupting
                      the eye for is the one that needs an answer. */}
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      ticket.status === "OPEN"
                        ? "bg-primary"
                        : ticket.status === "ANSWERED"
                          ? "bg-white/25"
                          : "bg-transparent",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {ticket.subject}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {relativeTime(ticket.lastMessageAt)}
                  </span>
                </div>
                <span className="truncate pl-3.5 text-xs text-muted-foreground">
                  {ticket.customer.email}
                </span>
              </Link>
            );
          })
        )}
      </div>

      {/* Said out loud rather than left to be inferred from a list that
          simply stops. The search box only looks at what is loaded, so
          an operator hunting an old conversation needs to know the rail
          is not the whole of it. */}
      {loadedShort && (
        <p className="px-1 text-xs text-muted-foreground tabular-nums">
          Showing the {bucket.items.length.toLocaleString()} most recent of{" "}
          {bucket.total.toLocaleString()}. Search covers these only.
        </p>
      )}
    </aside>
  );
}

/** Coarse on purpose. "3h" is what the operator needs to know; a
 * timestamp to the second in a list of forty is noise. */
function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
