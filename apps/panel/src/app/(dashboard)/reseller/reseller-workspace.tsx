"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Copy, Mail, Ticket, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ResellerBalance, ResellerVoucher } from "@/lib/types";
import { generateVoucher, resendVoucher, revokeVoucher } from "./actions";

export function ResellerWorkspace({
  balances,
  vouchers,
}: {
  balances: ResellerBalance[];
  vouchers: ResellerVoucher[];
}) {
  const [planId, setPlanId] = useState<string>(balances.find((b) => b.balance > 0)?.plan.id ?? "");
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState<string | null>(null);

  const selected = balances.find((b) => b.plan.id === planId);
  const totalLeft = balances.reduce((sum, b) => sum + b.balance, 0);

  function mint(withEmail: boolean) {
    if (!planId) return;
    // Checked here as well as on the server so the reseller is told
    // before an attempt that spends nothing -- the server is still the
    // one that decides, via a conditional update.
    if ((selected?.balance ?? 0) <= 0) {
      toast.error(`No ${selected?.plan.name ?? "plan"} tokens left`);
      return;
    }
    if (withEmail && !email.trim()) {
      toast.error("Enter an email address, or use Generate only");
      return;
    }

    startTransition(async () => {
      const result = await generateVoucher(planId, withEmail ? email.trim() : undefined);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      setEmail("");
      // Says what actually happened rather than assuming. A mint always
      // succeeds; the email may not, and a reseller who thinks it was
      // sent will not know to read the code out.
      if (withEmail && !result.data.emailed) {
        toast.warning(`Code ${result.data.code} created, but the email could not be sent`, {
          description: "Copy it from the list below and send it yourself.",
        });
      } else {
        toast.success(`Code ${result.data.code} created`, {
          description: withEmail ? `Emailed to ${result.data.recipientEmail}` : "Copy it below.",
        });
      }
    });
  }

  function copy(code: string) {
    void navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied((c) => (c === code ? null : c)), 1500);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* What is left, per plan. First thing a reseller wants to know. */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        {balances.map((b) => (
          <Card key={b.plan.id} className="p-4">
            <p className="text-sm text-muted-foreground">{b.plan.name}</p>
            <p
              className={
                b.balance > 0
                  ? "mt-1 text-3xl font-bold tabular-nums"
                  : "mt-1 text-3xl font-bold tabular-nums text-muted-foreground"
              }
            >
              {b.balance}
            </p>
            <p className="text-xs text-muted-foreground">
              {b.balance === 1 ? "code left" : "codes left"}
            </p>
          </Card>
        ))}
      </div>

      <Card className="flex flex-col gap-4 p-5">
        <div>
          <h2 className="text-base font-semibold">Generate a code</h2>
          <p className="text-sm text-muted-foreground">
            Each code activates one subscription for one customer and spends one token.
          </p>
        </div>

        {totalLeft === 0 ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            You have no tokens left. Ask the operator to top up your balance.
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Plan</Label>
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a plan" />
              </SelectTrigger>
              <SelectContent>
                {balances.map((b) => (
                  <SelectItem key={b.plan.id} value={b.plan.id} disabled={b.balance === 0}>
                    {b.plan.name} — {b.balance} left
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recipient">Customer email (optional)</Label>
            <Input
              id="recipient"
              type="email"
              placeholder="them@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => mint(true)} disabled={pending || !planId} className="gap-2">
            <Mail className="size-4" />
            Generate and send
          </Button>
          {/* The in-person case, which is a real workflow rather than a
              fallback -- a reseller standing in front of a customer
              reads the code out. */}
          <Button
            variant="secondary"
            onClick={() => mint(false)}
            disabled={pending || !planId}
            className="gap-2"
          >
            <Ticket className="size-4" />
            Generate only
          </Button>
        </div>
      </Card>

      <Card className="p-0">
        <div className="border-b border-white/5 p-5">
          <h2 className="text-base font-semibold">Codes you have issued</h2>
          <p className="text-sm text-muted-foreground">
            Deleting an unredeemed code gives the token back.
          </p>
        </div>

        {vouchers.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Sent to</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vouchers.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>
                    <button
                      onClick={() => copy(v.code)}
                      className="flex items-center gap-1.5 font-mono text-sm hover:text-primary"
                      title="Copy"
                    >
                      {v.code}
                      {copied === v.code ? (
                        <Check className="size-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="size-3.5 opacity-40" />
                      )}
                    </button>
                  </TableCell>
                  <TableCell>{v.plan.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {v.recipientEmail ?? <span className="italic">given in person</span>}
                  </TableCell>
                  <TableCell>
                    {v.redeemedCount > 0 ? (
                      <Badge className="bg-emerald-500/15 text-emerald-300">Redeemed</Badge>
                    ) : (
                      <Badge variant="secondary">Unused</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || !v.recipientEmail}
                        title={
                          v.recipientEmail
                            ? "Send this code again"
                            : "No email address on this code"
                        }
                        onClick={() =>
                          startTransition(async () => {
                            const r = await resendVoucher(v.id);
                            if (!r.ok) {
                              toast.error(r.error);
                              return;
                            }
                            toast[r.data.sent ? "success" : "warning"](
                              r.data.sent ? "Sent again" : "Could not send — check email settings",
                            );
                          })
                        }
                      >
                        <Mail className="size-4" />
                      </Button>
                      {/* Disabled rather than erroring after the fact:
                          once redeemed there is nothing to refund, and a
                          button that looks live and then fails is worse
                          than one that is plainly off. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || !v.canRevoke}
                        title={
                          v.canRevoke
                            ? "Delete and refund the token"
                            : "Already redeemed — cannot be deleted"
                        }
                        onClick={() =>
                          startTransition(async () => {
                            const r = await revokeVoucher(v.id);
                            if (!r.ok) {
                              toast.error(r.error);
                              return;
                            }
                            toast.success("Deleted, token refunded");
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
