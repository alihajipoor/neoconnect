"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, BellOff, CheckCircle2, Eye, RefreshCw, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import type { BlockIncident, BlockType, BlockWatchMode, BlockWatchOverview } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { answerIncident, runBlockWatchNow, type BlockAction } from "./actions";

const MODES: Record<BlockWatchMode, string> = {
  off: "Off. Nothing is evaluated. Set BLOCK_WATCH in infra/.env to turn it on.",
  record: "Recording only: verdicts appear here, nothing is sent.",
  digest: "Calibration: verdicts go to a daily digest by webhook and email; nothing pages.",
  notify: "On: likely blocks page you by webhook and email; suspicions go to the daily digest.",
};

const TYPES: Record<BlockType, string> = {
  address: "Address or port: connections from inside fail, from abroad they work.",
  protocol: "Some protocols: others on this server still carry for the same networks.",
  tunnel: "Tunnels: connections open but carry nothing (handshake, name or upload filtering).",
};

const STATUS_WORDS: Record<string, string> = {
  CLEARED: "cleared by itself",
  REPLACED: "marked replaced",
  RETIRED: "marked retired",
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function isFuture(iso: string | null): boolean {
  return iso !== null && new Date(iso).getTime() > Date.now();
}

export function BlockWatchView({ overview, canAct }: { overview: BlockWatchOverview; canAct: boolean }) {
  const [pending, startTransition] = useTransition();
  const where = overview.country.toUpperCase();

  const runNow = () =>
    startTransition(async () => {
      const result = await runBlockWatchNow();
      toast[result.ok ? "success" : "error"](result.ok ? "Evaluated" : result.error);
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Block watch</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Servers that look blocked from {where}, from the apps&apos; own connect reports, how many people
            are sending data, and the probes on Iran Reachability. One signal is a suspicion; a page needs
            independent signals that agree. A server that is down is an outage, not a block, and is never
            reported as one. Nothing here changes, buys or replaces a server &mdash; that is yours to do.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {MODES[overview.mode]} Last evaluated {ago(overview.lastCycleAt)}.
          </p>
        </div>
        {canAct && overview.mode !== "off" ? (
          <Button onClick={runNow} disabled={pending} variant="outline">
            <RefreshCw className={cn("mr-2 h-4 w-4", pending && "animate-spin")} />
            {pending ? "Evaluating…" : "Evaluate now"}
          </Button>
        ) : null}
      </div>

      {overview.open.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          <CheckCircle2 className="mr-2 inline h-4 w-4 text-emerald-400" />
          Nothing looks blocked{overview.mode === "off" ? " (but the watch is off)" : ""}.
        </Card>
      ) : (
        <div className="space-y-4">
          {overview.open.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} canAct={canAct} />
          ))}
        </div>
      )}

      {overview.closed.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Closed in the last two weeks</h2>
          <Card className="divide-y divide-white/5">
            {overview.closed.map((incident) => (
              <div key={incident.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2 text-sm">
                <span>
                  <span className="font-medium">{incident.node.name}</span>{" "}
                  <span className="text-muted-foreground">
                    {incident.verdict === "LIKELY_BLOCKED" ? "likely blocked" : "suspect"}, {STATUS_WORDS[incident.status]}
                    {incident.actedBy ? ` by ${incident.actedBy}` : ""}
                    {incident.actionNote ? ` — ${incident.actionNote}` : ""}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  opened {ago(incident.openedAt)}, closed {ago(incident.closedAt)}
                </span>
              </div>
            ))}
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function IncidentCard({ incident, canAct }: { incident: BlockIncident; canAct: boolean }) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const e = incident.evidenceJson;
  const likely = incident.verdict === "LIKELY_BLOCKED";
  const snoozed = isFuture(incident.snoozedUntil);

  const answer = (action: BlockAction, hours?: number) =>
    startTransition(async () => {
      const result = await answerIncident(incident.id, action, { hours, note: note.trim() || undefined });
      toast[result.ok ? "success" : "error"](result.ok ? "Recorded" : result.error);
    });

  return (
    <Card className={cn("space-y-3 p-4", likely ? "border-red-500/30 bg-red-500/5" : "border-amber-500/30 bg-amber-500/5")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            {likely ? <ShieldOff className="h-4 w-4 text-red-400" /> : <Eye className="h-4 w-4 text-amber-400" />}
            <span className="font-medium">{incident.node.name}</span>
            <Badge
              variant="outline"
              className={likely ? "border-red-500/30 text-red-400" : "border-amber-500/30 text-amber-400"}
            >
              {likely ? "Likely blocked" : "Suspect"}
            </Badge>
            {e.current === null && !e.outage ? (
              <span className="text-xs text-muted-foreground">quiet now; clears if it stays quiet</span>
            ) : null}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {incident.node.region} · opened {ago(incident.openedAt)} · last signal {ago(incident.lastSeenAt)}
            {incident.pagedAt ? ` · paged ${ago(incident.pagedAt)}` : ""}
            {incident.pageError ? <span className="text-red-400"> · page problem: {incident.pageError}</span> : null}
            {incident.keptAt ? " · kept" : ""}
            {snoozed ? ` · snoozed until ${new Date(incident.snoozedUntil!).toLocaleString()}` : ""}
          </div>
        </div>
      </div>

      {e.outage ? (
        <p className="text-sm text-amber-300">
          <AlertTriangle className="mr-1 inline h-4 w-4" />
          Right now this is an outage, not a block: {e.outage}.
        </p>
      ) : null}
      {e.reason ? <p className="text-sm">Why it is likely: {e.reason}.</p> : null}

      <ul className="space-y-1 text-sm">
        {e.families.map((f) => (
          <li key={f.family} className={f.firing ? "" : "text-muted-foreground"}>
            <span className={cn("mr-2 inline-block h-2 w-2 rounded-full", f.firing ? "bg-red-400" : "bg-white/20")} />
            {f.summary}
            {f.firing && e.since[f.family] ? (
              <span className="text-xs text-muted-foreground"> (since {ago(e.since[f.family] ?? null)})</span>
            ) : null}
          </li>
        ))}
      </ul>

      {e.blockType ? (
        <p className="text-xs text-muted-foreground">Best guess, not proof — {TYPES[e.blockType]}</p>
      ) : null}

      {canAct ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
            placeholder="Note (optional)"
            maxLength={500}
            className="h-8 min-w-48 flex-1 rounded-md border border-white/10 bg-transparent px-2 text-sm"
          />
          <Confirm
            label="Replace"
            title={`Mark ${incident.node.name} replaced?`}
            description="Closes this incident. Evidence from before now stops counting for this server, so a new address starts with a clean slate. Nothing is changed on any server."
            disabled={pending}
            onConfirm={() => answer("replaced")}
          />
          <Confirm
            label="Retire"
            title={`Mark ${incident.node.name} retired?`}
            description="Closes this incident and stops watching this server while it keeps its current address. Nothing is changed on any server."
            disabled={pending}
            onConfirm={() => answer("retired")}
          />
          <Button size="sm" variant="outline" disabled={pending || !!incident.keptAt} onClick={() => answer("keep")}>
            Keep
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => answer("snooze", 24)}>
            <BellOff className="mr-1 h-3.5 w-3.5" />
            Snooze 24h
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function Confirm({
  label,
  title,
  description,
  disabled,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
