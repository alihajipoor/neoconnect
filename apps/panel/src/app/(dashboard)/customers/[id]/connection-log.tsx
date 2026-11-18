"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Server } from "lucide-react";
import { toast } from "sonner";
import type {
  ApiTrace,
  ClientAttemptKind,
  ClientAttemptOutcome,
  CustomerAttemptDetail,
  CustomerAttemptRung,
} from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { ago, duration } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { KINDS, OUTCOMES } from "@/lib/attempt-labels";
import { categoryLabel, failureLabel } from "./insight-labels";
import { speedText, supportText, timesDiffer } from "./insight-format";
import { msText } from "./diagnostics-format";
import { ReportDetailsBlock } from "./report-details";

/** This customer's reports, newest first, as the apps sent them: the
 * rows of the Connections view's full log.
 *
 * The same reports as the Client Attempts page, narrowed to one person
 * and with the ladder's servers named -- which is what turns "they can't
 * connect" into "every server was too slow on this network" or "Stealth
 * came up on the German server and carried nothing". The detail stays
 * folded away per row: fifty open ladders is a wall nobody reads.
 */
export function AttemptTable({ attempts }: { attempts: CustomerAttemptDetail[] }) {
  return (
    <div className="rounded-lg border border-white/8 bg-card/40">
      <Table stack>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>When</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>App</TableHead>
            <TableHead>Network</TableHead>
            <TableHead>Landed on</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attempts.map((attempt) => (
            <AttemptRow key={attempt.id} attempt={attempt} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function AttemptRow({ attempt }: { attempt: CustomerAttemptDetail }) {
  const [open, setOpen] = useState(false);
  const outcome = OUTCOMES[attempt.outcome as ClientAttemptOutcome] ?? OUTCOMES.OTHER;
  const kind = KINDS[attempt.kind as ClientAttemptKind] ?? attempt.kind;
  // A row with a ladder is the interesting kind; flag the ones whose
  // ladder held a slow or dead rung even when the attempt as a whole
  // worked, because "connected on the fourth try" is a problem in waiting.
  const troubled = attempt.rungs.some((rung) => rungTone(rung.result) !== null);
  const services = attempt.kind === "SERVICE_CHECK" ? (attempt.details?.services ?? []) : [];
  const checked = services.length > 0 ? { ok: services.filter((s) => s.ok).length, total: services.length } : null;

  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <TableCell cell="lead" className="text-muted-foreground">
          {/* The row toggles on a click anywhere; this button is the same
              toggle for a keyboard and a screen reader. */}
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Hide this report's detail" : "Show this report's detail"}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((v) => !v);
            }}
            className="-m-1.5 flex size-7 items-center justify-center rounded-md outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </TableCell>
        <TableCell cell="primary" className="text-sm whitespace-nowrap" title={new Date(attempt.at).toLocaleString()}>
          <span suppressHydrationWarning>{ago(attempt.at)}</span>
        </TableCell>
        <TableCell cell="status">
          <div className="flex items-center gap-1.5 max-sm:flex-wrap max-sm:justify-end">
            {/* A service check is not a connection: its outcome is how many
                of the list's services were reachable, said as a count. */}
            {checked ? (
              <Badge variant={checked.ok === checked.total ? "success" : "outline"} className={cn(checked.ok < checked.total && "border-destructive/40 text-red-300")}>
                {checked.ok} of {checked.total} reachable
              </Badge>
            ) : (
              <Badge variant={outcome.variant} title={outcome.hint}>
                {outcome.label}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">{kind}</span>
            {troubled && (
              <span className="size-1.5 rounded-full bg-amber-400" title="A rung was too slow or carried nothing" />
            )}
          </div>
        </TableCell>
        <TableCell label="App" phoneOrder={2} className="text-sm whitespace-nowrap text-muted-foreground">
          {attempt.platform} {attempt.appVersion}
        </TableCell>
        <TableCell label="Network" wide phoneOrder={3} className="text-sm">
          <NetworkName network={attempt.network} />
        </TableCell>
        {/* Wraps between its parts, each kept whole, so the table fits its
            card at 1280 px instead of running past it. */}
        <TableCell label="Landed on" phoneOrder={1} className="text-sm">
          <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
            {attempt.protocol ? protocolLabel(attempt.protocol) : <span className="text-muted-foreground">—</span>}
            {/* The server it landed on, beside the protocol: which one it
                was is half of what a support question needs. */}
            {attempt.server && <span className="text-xs text-muted-foreground">on {attempt.server}</span>}
            {attempt.sessionSeconds !== null && (
              <span className="text-xs text-muted-foreground">up {duration(attempt.sessionSeconds)}</span>
            )}
          </span>
        </TableCell>
        {/* A table cell ignores max-width, so the cap alone let a long
            reason widen the table past its card; full width with a zero
            max-width makes this column take what the others leave and
            shorten to it. */}
        <TableCell
          hideOnPhone
          className="w-full max-w-0 truncate text-xs text-muted-foreground"
          title={attempt.reason ?? undefined}
        >
          {attempt.reason ?? ""}
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={7} className="bg-black/20 whitespace-normal">
            <div className="flex flex-col gap-3 py-1 pl-8 max-sm:pl-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {attempt.kind === "SERVICE_CHECK"
                    ? "A run of the service check: whether each service on the server's fixed list loaded, and how far it got."
                    : outcome.hint}
                </p>
                <CopyForSupport attempt={attempt} />
              </div>

              <div className="flex flex-wrap gap-6">
                <div>
                  <Label>Type</Label>
                  <p className="text-xs">{categoryLabel(attempt.category)}</p>
                </div>
                {attempt.failureCode && (
                  <div>
                    <Label>Failure cause, as the app reported it</Label>
                    <p className="text-xs">{failureLabel(attempt.failureCode)}</p>
                  </div>
                )}
              </div>

              {attempt.reason && (
                <div>
                  <Label>What the app said</Label>
                  {/* The apps send several lines ("tried 3 of 4
                      available\nStealth: ..."); keep them, and still wrap
                      a long one -- anywhere, so one long token cannot
                      widen the table past its card. */}
                  <p className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{attempt.reason}</p>
                </div>
              )}

              {attempt.rungs.length > 0 ? (
                <div>
                  <Label>Servers and protocols tried, in order</Label>
                  <ol className="flex flex-col gap-1">
                    {attempt.rungs.map((rung, index) => (
                      <RungLine key={index} rung={rung} index={index} />
                    ))}
                  </ol>
                </div>
              ) : attempt.kind === "SERVICE_CHECK" ? null : (
                <p className="text-xs text-muted-foreground">No ladder in this report.</p>
              )}

              {/* What the report's details carried; the service check's
                  results first, then the checks, then the device. */}
              <ReportDetailsBlock
                details={attempt.details}
                serviceTitle={
                  attempt.kind === "SERVICE_CHECK"
                    ? serviceRunTitle(attempt)
                    : undefined
                }
              />
              {attempt.kind === "SERVICE_CHECK" && !attempt.details?.services?.length && (
                <p className="text-xs text-muted-foreground">This report carried no results for the services on the list.</p>
              )}

              {attempt.apiTrace && <TraceTable trace={attempt.apiTrace} />}

              <div className="flex flex-wrap gap-6">
                {/* The apps queue reports while offline, so a report can
                    arrive long after it happened; both are shown only when
                    they differ, as one time otherwise. */}
                {timesDiffer(attempt) ? (
                  <>
                    <div>
                      <Label>Happened</Label>
                      <p className="text-xs">{new Date(attempt.occurredAt ?? attempt.at).toLocaleString()}</p>
                    </div>
                    <div>
                      <Label>Received</Label>
                      <p className="text-xs">{new Date(attempt.receivedAt).toLocaleString()}</p>
                    </div>
                  </>
                ) : (
                  <div>
                    <Label>Exact time</Label>
                    <p className="text-xs">{new Date(attempt.at).toLocaleString()}</p>
                  </div>
                )}
                <div>
                  <Label>From address</Label>
                  <FromAddress attempt={attempt} />
                </div>
                {attempt.sessionSeconds !== null && (
                  <div>
                    <Label>Carried traffic for</Label>
                    <p className="text-xs">{duration(attempt.sessionSeconds)}</p>
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

/** How the app tried to reach our API: each step, the address it dialled
 * and what came back, as the app wrote it. */
function TraceTable({ trace }: { trace: ApiTrace }) {
  return (
    <div>
      <Label>How the app tried to reach our API</Label>
      {trace.noneDialled && <p className="text-xs text-muted-foreground">No address was dialled.</p>}
      {trace.entries.length > 0 && (
        <div className="max-w-full overflow-x-auto">
          <table className="text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-0.5 pr-4 font-medium">Step</th>
                <th className="py-0.5 pr-4 font-medium">Address</th>
                <th className="py-0.5 pr-4 font-medium">Result</th>
                <th className="py-0.5 text-right font-medium">ms</th>
              </tr>
            </thead>
            <tbody>
              {trace.entries.map((entry, index) => (
                <tr key={index}>
                  <td className="py-0.5 pr-4 text-muted-foreground">{entry.leg ?? "—"}</td>
                  <td className="py-0.5 pr-4 font-mono break-all">{entry.target}</td>
                  <td className="py-0.5 pr-4 font-mono">{entry.outcome ?? "—"}</td>
                  <td className="py-0.5 text-right tabular-nums">{entry.ms ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {trace.cut > 0 && (
        <p className="text-xs text-muted-foreground">{trace.cut} more steps did not fit in the report.</p>
      )}
      {trace.probe && <p className="mt-1 font-mono text-xs break-words text-muted-foreground">{trace.probe}</p>}
    </div>
  );
}

/** Copies a plain-text account of this one attempt, without the
 * customer's email or address (insight-format.ts `supportText`). */
function CopyForSupport({ attempt }: { attempt: CustomerAttemptDetail }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="max-sm:h-11 max-sm:w-full"
      onClick={(event) => {
        event.stopPropagation();
        navigator.clipboard
          .writeText(supportText(attempt))
          .then(() => toast.success("Copied"))
          .catch(() => toast.error("Could not copy"));
      }}
    >
      <Copy /> Copy for support
    </Button>
  );
}

/** One rung. The result is the app's own words; the two that matter most
 * are coloured so they can be found in a long ladder at a glance:
 * "too slow" (it worked, but the latency check passed it over) and "not
 * carrying" (it came up and moved nothing -- usually a blocked port or
 * protocol on that network). */
function RungLine({ rung, index }: { rung: CustomerAttemptRung; index: number }) {
  const tone = rungTone(rung.result);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">{index + 1}</span>
      <Server className="size-3 shrink-0 translate-y-0.5 text-muted-foreground" />
      <span className="font-medium">{rung.server ?? "unknown server"}</span>
      <span className="text-muted-foreground">{rung.protocol ? protocolLabel(rung.protocol) : "unknown protocol"}</span>
      <span
        className={cn(
          tone === "slow" && "rounded bg-amber-500/10 px-1 text-amber-300",
          tone === "dead" && "rounded bg-destructive/15 px-1 text-red-300",
          tone === null && "text-foreground/90",
        )}
      >
        {rung.result}
      </span>
      {rung.carried === true && <span className="text-success">carried traffic</span>}
      {rung.carried === false && <span className="text-muted-foreground">carried nothing</span>}
      {/* What the tunnel actually moved once it landed -- the figure that
          tells a server that passed the check from one that is any use. */}
      {speedLine(rung) && <span className="text-muted-foreground">{speedLine(rung)}</span>}
      {typeof rung.ms === "number" && (
        <span className="text-muted-foreground tabular-nums">took {msText(rung.ms)}</span>
      )}
    </li>
  );
}

/** "Services checked through germany-3, Stealth" or "... outside the VPN". */
function serviceRunTitle(attempt: CustomerAttemptDetail): string {
  if (attempt.details?.via === "direct") return "Services checked outside the VPN";
  if (attempt.server) {
    return `Services checked through ${attempt.server}${attempt.protocol ? `, ${protocolLabel(attempt.protocol)}` : ""}`;
  }
  return attempt.details?.via === "tunnel" ? "Services checked through the VPN" : "Services checked";
}

function speedLine(rung: Pick<CustomerAttemptRung, "downKbps" | "upKbps">): string | null {
  const text = speedText(rung.downKbps, rung.upKbps);
  return text ? `about ${text}` : null;
}

function rungTone(result: string): "slow" | "dead" | null {
  const text = result.toLowerCase();
  if (text.includes("not carrying")) return "dead";
  if (text.includes("too slow")) return "slow";
  return null;
}

/** Where the report came from. Never a bare blank: when there is no
 * address, it says why.
 *
 * A report sent through the tunnel it is about arrives from our server.
 * The server the customer connected to normally supplies their own
 * address within a minute or so, and the row then shows it like any
 * other; one still naming a server is one where that could not be done
 * -- a node too old to send addresses, a report the app sent late, or
 * two devices where saying which sent it would be a guess. */
function FromAddress({ attempt }: { attempt: CustomerAttemptDetail }) {
  if (attempt.ip) return <p className="font-mono text-xs">{attempt.ip}</p>;
  const [text, note] = attempt.throughServer
    ? ["Not known", `the app's report came through ${attempt.throughServer}`]
    : attempt.noAddress === "erased"
      ? ["Erased", "addresses are kept for 14 days"]
      : attempt.noAddress === "relay"
        ? ["Not kept", "sent over the backup route"]
        : ["Not known", null];
  return (
    <p className="text-xs">
      {text}
      {note && <span className="ml-1.5 text-muted-foreground">{note}</span>}
    </p>
  );
}

function NetworkName({ network }: { network: CustomerAttemptDetail["network"] }) {
  if (!network) return <span className="text-muted-foreground">unknown</span>;
  return (
    <span className="whitespace-nowrap">
      {network.name ?? "Unnamed network"}
      <span className="ml-1.5 font-mono text-xs text-muted-foreground">AS{network.asn}</span>
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</p>;
}
