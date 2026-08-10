"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  CloudOff,
  Radio,
  Search,
  ShieldOff,
  Activity,
} from "lucide-react";
import type {
  ClientAttempt,
  ClientAttemptKind,
  ClientAttemptOutcome,
  ClientAttemptSummaryRow,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** How each outcome reads to an operator, and how loudly.
 *
 * The wording matters more than usual here. The enum names are precise
 * and unreadable at a glance, and the whole value of this page is
 * telling two failures apart quickly: a filtered address and a wrong
 * password are both "could not sign in" to the customer and mean
 * completely different things to us.
 */
const OUTCOMES: Record<
  ClientAttemptOutcome,
  { label: string; hint: string; variant: "success" | "destructive" | "highlight" | "secondary" }
> = {
  SUCCESS: { label: "Worked", hint: "Nothing to do.", variant: "success" },
  CONTROL_PLANE_UNREACHABLE: {
    label: "No control plane",
    hint: "Every API address failed or timed out. The signature of a filtered address.",
    variant: "destructive",
  },
  NOT_CARRYING_TRAFFIC: {
    label: "Tunnel carried nothing",
    hint: "The engine came up but no traffic crossed it. Usually a blocked protocol or port.",
    variant: "destructive",
  },
  ENGINE_FAILED: {
    label: "Engine failed",
    hint: "The VPN engine itself refused to start. A client-side fault, not a network one.",
    variant: "destructive",
  },
  REJECTED: {
    label: "Refused",
    hint: "The server answered and said no: wrong password, unverified email, quota gone.",
    variant: "highlight",
  },
  PERMISSION_DENIED: {
    label: "Permission denied",
    hint: "The customer declined the VPN permission prompt.",
    variant: "secondary",
  },
  OTHER: { label: "Other", hint: "See the reason on the row.", variant: "secondary" },
};

/** Filter pills, ordered by how much an operator cares. Failures first,
 * successes behind an explicit choice. */
const FILTERS: { label: string; href: string; match: (o: ClientAttemptOutcome | null, f: boolean) => boolean }[] = [
  { label: "All failures", href: "/client-attempts", match: (o, f) => o === null && f },
  {
    label: "No control plane",
    href: "/client-attempts?outcome=CONTROL_PLANE_UNREACHABLE",
    match: (o) => o === "CONTROL_PLANE_UNREACHABLE",
  },
  {
    label: "Carried nothing",
    href: "/client-attempts?outcome=NOT_CARRYING_TRAFFIC",
    match: (o) => o === "NOT_CARRYING_TRAFFIC",
  },
  { label: "Refused", href: "/client-attempts?outcome=REJECTED", match: (o) => o === "REJECTED" },
  {
    label: "Engine failed",
    href: "/client-attempts?outcome=ENGINE_FAILED",
    match: (o) => o === "ENGINE_FAILED",
  },
  { label: "Everything", href: "/client-attempts?failures=0", match: (o, f) => o === null && !f },
];

const KINDS: Record<ClientAttemptKind, string> = {
  REGISTER: "Sign-up",
  SIGN_IN: "Sign-in",
  CONNECT: "Connect",
};

export function ClientAttemptsView({
  attempts,
  summary,
  summaryHours,
  activeOutcome,
  failuresOnly,
}: {
  attempts: ClientAttempt[];
  summary: ClientAttemptSummaryRow[];
  summaryHours: number;
  activeOutcome: ClientAttemptOutcome | null;
  failuresOnly: boolean;
}) {
  const [query, setQuery] = useState("");

  // Client-side, like Invoices: the operator's real task is "find the
  // report my friend just made", against a list already narrowed by
  // outcome, and a round trip per keystroke would be slower.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return attempts;
    return attempts.filter((a) =>
      [a.customer?.email, a.ip, a.reason, a.appVersion, a.platform, a.protocol, a.apiEndpoint]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle)),
    );
  }, [attempts, query]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Client Attempts</h1>
        <p className="text-sm text-muted-foreground">
          What the apps report back when they try to sign in or connect — including from people who
          never reached us. Kept for 14 days, then deleted.
        </p>
      </div>

      <SummaryCard summary={summary} hours={summaryHours} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((filter) => {
            const active = filter.match(activeOutcome, failuresOnly);
            return (
              <Link
                key={filter.label}
                href={filter.href}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                )}
              >
                {filter.label}
              </Link>
            );
          })}
        </div>
        <div className="relative sm:w-72">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search email, IP, version, or error"
            className="pl-9"
            aria-label="Search attempts"
          />
        </div>
      </div>

      <div className="rounded-lg border border-white/8 bg-card/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>When</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Doing</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>App</TableHead>
              <TableHead>From</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  {attempts.length > 0 ? (
                    "Nothing matches that search."
                  ) : failuresOnly && !activeOutcome ? (
                    <>
                      <Activity className="mx-auto mb-2 size-5 opacity-50" />
                      No failures reported. Either nothing is broken, or no client has reported yet.
                    </>
                  ) : (
                    "Nothing reported in this category."
                  )}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((attempt) => <AttemptRow key={attempt.id} attempt={attempt} />)
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** One row, expandable into whatever detail the client sent.
 *
 * The ladder is the reason this page exists rather than a log file:
 * "Fast was refused, Stealth came up but carried nothing, Stealth HTTPS
 * worked" is a diagnosis, and the summary line above it is not. It stays
 * folded away because most rows do not have one and a table that shows
 * everything shows nothing. */
function AttemptRow({ attempt }: { attempt: ClientAttempt }) {
  const [open, setOpen] = useState(false);
  const outcome = OUTCOMES[attempt.outcome] ?? OUTCOMES.OTHER;
  const hasDetail = Boolean(
    attempt.reason || attempt.attemptsJson?.length || attempt.apiEndpoint || attempt.protocol,
  );

  return (
    <>
      <TableRow
        className={cn(hasDetail && "cursor-pointer")}
        onClick={hasDetail ? () => setOpen((v) => !v) : undefined}
      >
        <TableCell className="text-muted-foreground">
          {hasDetail &&
            (open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />)}
        </TableCell>
        <TableCell
          className="whitespace-nowrap text-sm"
          title={new Date(attempt.occurredAt ?? attempt.createdAt).toLocaleString()}
        >
          {ago(attempt.occurredAt ?? attempt.createdAt)}
          {/* A report that could not be sent when it happened is the
              normal case for "no control plane" -- the client had no way
              to tell us at the time. Say so, or a delayed report reads as
              a fresh one. */}
          {attempt.occurredAt && lateBy(attempt) && (
            <span className="ml-1.5 text-xs text-muted-foreground" title="Queued on the device until it could reach us">
              (reported {lateBy(attempt)} later)
            </span>
          )}
        </TableCell>
        <TableCell>
          <Badge variant={outcome.variant} title={outcome.hint}>
            {outcome.label}
          </Badge>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">{KINDS[attempt.kind] ?? attempt.kind}</TableCell>
        <TableCell className="text-sm">
          {attempt.customer?.email ?? (
            // Not a gap in the data -- a sign-up that failed or a client
            // that never got a session has nobody to name, and those are
            // the reports worth having.
            <span className="text-muted-foreground italic">no session</span>
          )}
        </TableCell>
        <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
          {attempt.platform} {attempt.appVersion}
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">{attempt.ip ?? "—"}</TableCell>
      </TableRow>

      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={7} className="bg-black/20">
            <div className="flex flex-col gap-3 py-1 pl-8">
              <p className="text-xs text-muted-foreground">{outcome.hint}</p>

              {attempt.reason && (
                <div>
                  <Label>What the app said</Label>
                  <p className="font-mono text-xs break-words">{attempt.reason}</p>
                </div>
              )}

              {attempt.attemptsJson?.length ? (
                <div>
                  <Label>Failover ladder</Label>
                  <ol className="flex flex-col gap-1">
                    {attempt.attemptsJson.map((rung, index) => (
                      <li key={`${rung.protocol}-${index}`} className="flex items-baseline gap-2 text-xs">
                        <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">
                          {index + 1}
                        </span>
                        <Radio className="size-3 shrink-0 translate-y-0.5 text-muted-foreground" />
                        <span className="font-medium">{rung.protocol}</span>
                        <span className="text-muted-foreground">{rung.result}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-6">
                {attempt.protocol && (
                  <div>
                    <Label>Protocol</Label>
                    <p className="text-xs">{attempt.protocol}</p>
                  </div>
                )}
                {attempt.apiEndpoint && (
                  <div>
                    <Label>API address that answered</Label>
                    <p className="font-mono text-xs break-all">{attempt.apiEndpoint}</p>
                  </div>
                )}
                <div>
                  <Label>{attempt.occurredAt ? "Happened" : "Exact time"}</Label>
                  <p className="text-xs">
                    {new Date(attempt.occurredAt ?? attempt.createdAt).toLocaleString()}
                  </p>
                </div>
                {attempt.occurredAt && (
                  <div>
                    <Label>Reached us</Label>
                    <p className="text-xs">{new Date(attempt.createdAt).toLocaleString()}</p>
                  </div>
                )}
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</p>;
}

/** The headline: how much is failing, and of what kind.
 *
 * Proportion rather than volume is the useful signal in a beta -- "nine
 * of eleven connects never reached the control plane" is a diagnosis,
 * "eleven attempts" is not.
 */
function SummaryCard({ summary, hours }: { summary: ClientAttemptSummaryRow[]; hours: number }) {
  const total = summary.reduce((sum, row) => sum + row.count, 0);
  const succeeded = summary.find((row) => row.outcome === "SUCCESS")?.count ?? 0;
  const failed = total - succeeded;
  const failures = summary
    .filter((row) => row.outcome !== "SUCCESS" && row.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{total}</p>
          <p className="text-xs text-muted-foreground">attempts in the last {hours}h</p>
        </div>
        <div>
          <p
            className={cn(
              "text-2xl font-semibold tabular-nums",
              failed > 0 ? "text-destructive" : "text-success",
            )}
          >
            {failed}
          </p>
          <p className="text-xs text-muted-foreground">
            failed{total > 0 && ` — ${Math.round((failed / total) * 100)}%`}
          </p>
        </div>
      </div>

      {total === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CloudOff className="size-4" />
          Nothing reported yet. Clients report on every sign-in and connect, so this fills in as
          soon as one is used.
        </p>
      ) : failures.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <ShieldOff className="size-4" />
          Every reported attempt worked.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {/* One bar per failure kind, each scaled against the largest,
              so the shape of the problem is readable before the numbers
              are. Scaled against the largest rather than the total
              because the question is which failure dominates, and against
              a total of mostly-successes every bar would be a sliver. */}
          {failures.map((row) => {
            const meta = OUTCOMES[row.outcome] ?? OUTCOMES.OTHER;
            return (
              <div key={row.outcome} className="flex items-center gap-3">
                <span className="w-44 shrink-0 text-xs text-muted-foreground">{meta.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      meta.variant === "destructive" ? "bg-destructive" : "bg-highlight",
                    )}
                    style={{ width: `${Math.max(4, (row.count / failures[0].count) * 100)}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-xs tabular-nums">{row.count}</span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** How far behind the event the report arrived, or null if it was close
 * enough that saying so would be noise. */
function lateBy(attempt: ClientAttempt): string | null {
  if (!attempt.occurredAt) return null;
  const minutes = Math.round(
    (new Date(attempt.createdAt).getTime() - new Date(attempt.occurredAt).getTime()) / 60_000,
  );
  if (minutes < 2) return null;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** Relative time, because the question this page answers is almost
 * always "what just happened". The exact timestamp is on hover and in
 * the expanded row. */
function ago(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
