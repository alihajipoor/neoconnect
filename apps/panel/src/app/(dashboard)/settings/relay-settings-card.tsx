"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateRelayAuthAction } from "./actions";
import type { RelayAuthMode, RelayAuthStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const MODES: { value: RelayAuthMode; label: string; help: string }[] = [
  {
    value: "OFF",
    label: "Off",
    help: "No sign-up or unverified sign-in through the Iranian relay. Verified customers can still sign in through it.",
  },
  {
    value: "AUTO",
    label: "Auto (default)",
    help: "Relay sign-up at the normal caps (200 a day). If Iranian traffic drops while the rest holds, you are alerted after 30 minutes and the caps rise after an hour. Nothing customers read changes.",
  },
  {
    value: "INTRANET",
    label: "Intranet declared",
    help: "Intranet caps (3,000 a day), the apps say the national intranet is on, and the unverified-account and idle-session sweeps pause until 30 days after you switch back.",
  },
];

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/** The owner's switch for sign-up through the Iranian relay of last
 * resort (docs/relay-last-resort.md), and what it has done today. */
export function RelaySettingsCard({ status }: { status: RelayAuthStatus }) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<RelayAuthMode>(status.settings.mode);
  const [asns, setAsns] = useState(status.settings.hostingAsns.join(", "));
  const s = status.settings;

  function save() {
    const parsed = asns
      .split(/[\s,]+/)
      .map((t) => t.replace(/^AS/i, ""))
      .filter(Boolean)
      .map(Number);
    if (parsed.some((n) => !Number.isInteger(n) || n < 1)) {
      toast.error("Hosting networks are AS numbers, separated by commas.");
      return;
    }
    if (mode === "INTRANET" && s.mode !== "INTRANET" && !confirm("Declare the national intranet? The apps will say so.")) {
      return;
    }
    startTransition(async () => {
      const result = await updateRelayAuthAction({ mode, hostingAsns: parsed });
      if (result.ok) toast.success("Relay sign-up settings saved");
      else toast.error(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="border-white/10 bg-card/80">
        <CardHeader>
          <CardTitle className="text-lg">Relay sign-up</CardTitle>
          <CardDescription>
            Sign-up and sign-in through the Iranian relay when nothing else reaches us. Relay accounts skip email
            verification and can redeem only single-use Ultimate vouchers until they confirm their address.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="relay-mode">Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as RelayAuthMode)}>
              <SelectTrigger id="relay-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{MODES.find((m) => m.value === mode)?.help}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="relay-asns">Hosting networks (AS numbers)</Label>
            <Input id="relay-asns" value={asns} onChange={(e) => setAsns(e.target.value)} placeholder="e.g. 12345, 67890" />
            <p className="text-sm text-muted-foreground">
              Data-centre networks share {status.caps.hosting} sign-ups a day between them.
            </p>
          </div>
          <Button onClick={save} disabled={pending} className="self-start">
            {pending ? "Saving..." : "Save"}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-white/10 bg-card/80">
        <CardHeader>
          <CardTitle className="text-base">Today (UTC)</CardTitle>
          <CardDescription>
            Caps: {status.caps.global} a day, {status.caps.perNetwork} per network, 30 per caller.{" "}
            <Badge variant="outline">{status.tier === "intranet" ? "Intranet tier" : "Normal tier"}</Badge>{" "}
            {status.hold && <Badge variant="outline">Sweeps paused</Badge>}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <p>
            {status.today.signups} sign-ups, {status.today.signIns} sign-ins, {status.today.refusals} refused.
          </p>
          {status.today.rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Box</TableHead>
                  <TableHead>Network</TableHead>
                  <TableHead className="text-right">Sign-ups</TableHead>
                  <TableHead className="text-right">Sign-ins</TableHead>
                  <TableHead className="text-right">Refused</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.today.rows.map((r) => (
                  <TableRow key={`${r.box}|${r.asn}`}>
                    <TableCell>{r.box || "—"}</TableCell>
                    <TableCell>{r.asn ? `AS${r.asn}${r.org ? ` ${r.org}` : ""}` : "unknown"}</TableCell>
                    <TableCell className="text-right">{r.signups}</TableCell>
                    <TableCell className="text-right">{r.signIns}</TableCell>
                    <TableCell className="text-right">{r.refusals}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="text-muted-foreground">
            <p>Intranet declared: {when(s.intranetDeclaredAt)} · ended: {when(s.intranetEndedAt)}</p>
            <p>
              Detector: drop seen since {when(s.suspectedSince)} · alerted {when(s.suspicionAlertedAt)} · caps raised{" "}
              {when(s.capsRaisedAt)}
            </p>
            {status.detector && (
              <p>
                Last half hour: Iran {status.detector.ir} (median {status.detector.irMedian}), elsewhere{" "}
                {status.detector.other} (median {status.detector.otherMedian}).
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
