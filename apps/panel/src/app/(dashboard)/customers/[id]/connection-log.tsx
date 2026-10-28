"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Server } from "lucide-react";
import type { ClientAttemptKind, ClientAttemptOutcome, CustomerAttempt, CustomerAttemptRung } from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { ago, duration } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { KINDS, OUTCOMES } from "../../client-attempts/client-attempts-view";

/** This customer's sign-ins and connects, newest first, as the apps
 * reported them.
 *
 * The same reports as the Client Attempts page, narrowed to one person
 * and with the ladder's servers named -- which is what turns "they can't
 * connect" into "every server was too slow on this network" or "Stealth
 * came up on the German server and carried nothing". The ladder stays
 * folded away per row: most rows have one, and fifty open ladders is a
 * wall nobody reads.
 */
export function ConnectionLog({
  attempts,
  shown,
}: {
  /** Null when the activity endpoint failed. */
  attempts: CustomerAttempt[] | null;
  /** How many the page asked for, so a full card says it is a window. */
  shown: number;
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">
          Connection log
          {attempts && attempts.length >= shown && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">newest {shown}</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {attempts === null ? (
          <p className="text-sm text-muted-foreground">Could not load this customer&apos;s attempts.</p>
        ) : attempts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sign-ins or connects reported in the last 14 days. A report needs the app to reach us
            at some point, so someone whose every attempt failed before signing in shows up only on
            the{" "}
            <Link href="/client-attempts" className="underline hover:text-foreground">
              Client Attempts
            </Link>{" "}
            page, without a name.
          </p>
        ) : (
          <div className="rounded-lg border border-white/8 bg-card/40">
            <Table>
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
        )}
      </CardContent>
    </Card>
  );
}

function AttemptRow({ attempt }: { attempt: CustomerAttempt }) {
  const [open, setOpen] = useState(false);
  const outcome = OUTCOMES[attempt.outcome as ClientAttemptOutcome] ?? OUTCOMES.OTHER;
  const kind = KINDS[attempt.kind as ClientAttemptKind] ?? attempt.kind;
  // A row with a ladder is the interesting kind; flag the ones whose
  // ladder held a slow or dead rung even when the attempt as a whole
  // worked, because "connected on the fourth try" is a problem in waiting.
  const troubled = attempt.rungs.some((rung) => rungTone(rung.result) !== null);

  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <TableCell className="text-muted-foreground">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </TableCell>
        <TableCell className="text-sm whitespace-nowrap" title={new Date(attempt.at).toLocaleString()}>
          <span suppressHydrationWarning>{ago(attempt.at)}</span>
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <Badge variant={outcome.variant} title={outcome.hint}>
              {outcome.label}
            </Badge>
            <span className="text-xs text-muted-foreground">{kind}</span>
            {troubled && (
              <span className="size-1.5 rounded-full bg-amber-400" title="A rung was too slow or carried nothing" />
            )}
          </div>
        </TableCell>
        <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
          {attempt.platform} {attempt.appVersion}
        </TableCell>
        <TableCell className="text-sm">
          <NetworkName network={attempt.network} />
        </TableCell>
        <TableCell className="text-sm whitespace-nowrap">
          {attempt.protocol ? protocolLabel(attempt.protocol) : <span className="text-muted-foreground">—</span>}
          {/* The server it landed on, beside the protocol: which one it
              was is half of what a support question needs. */}
          {attempt.server && <span className="ml-1.5 text-xs text-muted-foreground">on {attempt.server}</span>}
          {attempt.sessionSeconds !== null && (
            <span className="ml-1.5 text-xs text-muted-foreground">up {duration(attempt.sessionSeconds)}</span>
          )}
        </TableCell>
        <TableCell className="max-w-72 truncate text-xs text-muted-foreground" title={attempt.reason ?? undefined}>
          {attempt.reason ?? ""}
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={7} className="bg-black/20 whitespace-normal">
            <div className="flex flex-col gap-3 py-1 pl-8">
              <p className="text-xs text-muted-foreground">{outcome.hint}</p>

              {attempt.reason && (
                <div>
                  <Label>What the app said</Label>
                  <p className="font-mono text-xs break-words">{attempt.reason}</p>
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
              ) : (
                <p className="text-xs text-muted-foreground">No ladder in this report.</p>
              )}

              <div className="flex flex-wrap gap-6">
                <div>
                  <Label>Exact time</Label>
                  <p className="text-xs">{new Date(attempt.at).toLocaleString()}</p>
                </div>
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
    </li>
  );
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
function FromAddress({ attempt }: { attempt: CustomerAttempt }) {
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

function NetworkName({ network }: { network: CustomerAttempt["network"] }) {
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
