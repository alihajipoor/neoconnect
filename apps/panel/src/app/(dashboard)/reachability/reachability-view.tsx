"use client";

import { Fragment, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw, ShieldOff, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import type { NodeReachability, ReachabilityVerdict } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { runReachabilityNow } from "./actions";

/**
 * How each verdict reads to an operator, and how loudly.
 *
 * INCONCLUSIVE is deliberately grey rather than red. It means the probe
 * service told us nothing, which is a fact about the prober and not
 * about the node -- colouring it as a failure would train the operator
 * to see a fleet-wide outage every time check-host has a bad minute.
 */
const VERDICTS: Record<
  ReachabilityVerdict,
  { label: string; hint: string; className: string; Icon: typeof CheckCircle2 }
> = {
  REACHABLE: {
    label: "Reachable",
    hint: "Most Iranian networks could open a connection.",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    Icon: CheckCircle2,
  },
  DEGRADED: {
    label: "Partly blocked",
    hint: "Some Iranian operators could connect and some could not. Usually one ISP filtering, not the node being down.",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    Icon: AlertTriangle,
  },
  UNREACHABLE: {
    label: "Unreachable",
    hint: "No Iranian network could open a connection. Most likely filtered.",
    className: "border-red-500/30 bg-red-500/10 text-red-400",
    Icon: ShieldOff,
  },
  INCONCLUSIVE: {
    label: "No data",
    hint: "The probe service did not answer. This says nothing about the node.",
    className: "border-white/15 bg-white/5 text-muted-foreground",
    Icon: HelpCircle,
  },
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ReachabilityView({
  nodes,
  canProbe,
}: {
  nodes: NodeReachability[];
  canProbe: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const probeNow = () =>
    startTransition(async () => {
      const result = await runReachabilityNow();
      toast[result.ok ? "success" : "error"](
        result.ok ? "Probe finished" : (result.error ?? "Could not run the probe"),
      );
    });

  // The condition the page exists for: the agent says the node is fine
  // and Iran cannot reach it. Counted separately so it can be stated in
  // words rather than left for the reader to spot in the table.
  const blocked = nodes.filter((n) => n.verdict === "UNREACHABLE");
  const degraded = nodes.filter((n) => n.verdict === "DEGRADED");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Iran Reachability</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Each node is probed every 30 minutes from vantage points inside Iran, by opening a TCP
            connection to the port customers actually use. A node&apos;s agent can report{" "}
            <code className="text-foreground">ONLINE</code> while being blocked at the border &mdash;
            the agent heartbeats outbound, so it keeps working when inbound connections are dropped.
            This page is the only thing that sees that.
          </p>
        </div>
        {canProbe ? (
          <Button onClick={probeNow} disabled={pending} variant="outline">
            <RefreshCw className={cn("mr-2 h-4 w-4", pending && "animate-spin")} />
            {pending ? "Probing…" : "Probe now"}
          </Button>
        ) : null}
      </div>

      {blocked.length > 0 ? (
        <Card className="border-red-500/30 bg-red-500/5 p-4">
          <p className="text-sm">
            <strong>{blocked.map((n) => n.name).join(", ")}</strong>{" "}
            {blocked.length === 1 ? "is" : "are"} unreachable from Iran. Check the node directly
            before assuming a block &mdash; a dead host and a filtered address look identical from
            here.
          </p>
        </Card>
      ) : null}

      {degraded.length > 0 ? (
        <Card className="border-amber-500/30 bg-amber-500/5 p-4">
          <p className="text-sm">
            {degraded.map((n) => n.name).join(", ")} reachable on some Iranian networks but not
            others. Expand a row to see which operators failed. This does not raise an alert on its
            own.
          </p>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Node</TableHead>
              <TableHead>From Iran</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Networks OK</TableHead>
              <TableHead>Latency</TableHead>
              <TableHead>Checked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                  No nodes yet.
                </TableCell>
              </TableRow>
            ) : null}

            {nodes.map((node) => {
              const verdict = node.verdict ? VERDICTS[node.verdict] : null;
              const open = expanded === node.nodeId;
              // ONLINE agent + unreachable from Iran. Not a contradiction,
              // but it reads as one unless it is pointed at.
              const contradiction = node.agentStatus === "ONLINE" && node.verdict === "UNREACHABLE";

              return (
                // Fragment carries the key: the row and its detail row
                // are one list item, and a shorthand <> cannot take one.
                <Fragment key={node.nodeId}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => setExpanded(open ? null : node.nodeId)}
                  >
                    <TableCell className="text-muted-foreground">
                      {open ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{node.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {node.region} &middot; port {node.port}
                      </div>
                    </TableCell>
                    <TableCell>
                      {verdict ? (
                        <Badge variant="outline" className={verdict.className} title={verdict.hint}>
                          <verdict.Icon className="mr-1 h-3 w-3" />
                          {verdict.label}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">not probed yet</span>
                      )}
                      {node.openSince ? (
                        <div className="mt-1 text-xs text-red-400">
                          since {ago(node.openSince)}
                          {node.alertDelivered === false ? " · alert email failed" : ""}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-xs",
                          contradiction ? "text-amber-400" : "text-muted-foreground",
                        )}
                        title={
                          contradiction
                            ? "The agent heartbeats outbound, so it stays ONLINE while inbound connections from Iran are blocked."
                            : undefined
                        }
                      >
                        {node.agentStatus}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {node.probesAnswered ? `${node.probesOk}/${node.probesAnswered}` : "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {node.medianLatencyMs ? `${node.medianLatencyMs} ms` : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {ago(node.checkedAt)}
                    </TableCell>
                  </TableRow>

                  {open ? (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-white/[0.02]">
                        {node.detail.length === 0 ? (
                          <p className="py-2 text-sm text-muted-foreground">
                            No per-network detail for the last check.
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-2 py-2">
                            {node.detail.map((probe) => (
                              <div
                                key={probe.vantage}
                                className={cn(
                                  "rounded-md border px-2.5 py-1.5 text-xs",
                                  probe.ok
                                    ? "border-emerald-500/25 bg-emerald-500/5"
                                    : "border-red-500/25 bg-red-500/5",
                                )}
                                title={probe.error ?? undefined}
                              >
                                <div className="font-medium">
                                  {probe.city ?? probe.vantage}{" "}
                                  <span className="text-muted-foreground">
                                    {probe.asn ?? probe.vantage}
                                  </span>
                                </div>
                                <div
                                  className={probe.ok ? "text-emerald-400" : "text-red-400"}
                                >
                                  {probe.ok ? `${probe.latencyMs} ms` : (probe.error ?? "failed")}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <p className="text-xs text-muted-foreground">
        An email goes out after two consecutive unreachable checks (about an hour), and once more
        when the node recovers. &ldquo;No data&rdquo; never raises an alert: when the probe service
        is down every node looks dead at once, and that is not the fleet being blocked.
      </p>
    </div>
  );
}
