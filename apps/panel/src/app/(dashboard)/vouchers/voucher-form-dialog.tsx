"use client";

import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { createVoucher, updateVoucher, type VoucherInput } from "./actions";
import type { SubscriptionPlan, VoucherListRow } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** How long a voucher may be used for, as one choice rather than two
 * fields.
 *
 * The operator asked for one-time, expiring and unlimited codes. Those
 * are two independent limits underneath -- a redemption cap and an
 * expiry date, either of which may be absent -- but presenting them as
 * two nullable inputs makes the common cases fiddly to express and the
 * meaningless combination (cap of zero) reachable. A radio here, two
 * columns in the database. */
type Usage = "once" | "limited" | "unlimited";

function usageOf(voucher: VoucherListRow | undefined): Usage {
  if (!voucher || voucher.maxRedemptions === null) return voucher ? "unlimited" : "once";
  return voucher.maxRedemptions === 1 ? "once" : "limited";
}

export function VoucherFormDialog({
  plans,
  voucher,
  trigger,
}: {
  plans: SubscriptionPlan[];
  /** Absent when creating. The narrow list row rather than a whole
   * `Voucher` because editing only ever starts from the table, and every
   * field the form seeds itself from -- plan, limits, expiry, note,
   * active -- is still on the list projection. */
  voucher?: VoucherListRow;
  trigger: ReactNode;
}) {
  const editing = Boolean(voucher);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [planId, setPlanId] = useState(voucher?.planId ?? plans[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [usage, setUsage] = useState<Usage>(usageOf(voucher));
  const [limit, setLimit] = useState(String(voucher?.maxRedemptions ?? 10));
  const [expires, setExpires] = useState(voucher?.expiresAt?.slice(0, 10) ?? "");
  const [note, setNote] = useState(voucher?.note ?? "");
  const [isActive, setIsActive] = useState(voucher?.isActive ?? true);

  function submit(event: React.FormEvent) {
    event.preventDefault();

    const maxRedemptions =
      usage === "once" ? 1 : usage === "limited" ? Number(limit) || 1 : null;
    // Dates arrive as a plain day. End of that day rather than its start,
    // so a voucher set to expire "on the 9th" works all day on the 9th
    // -- which is what anybody setting that date means.
    const expiresAt = expires ? new Date(`${expires}T23:59:59`).toISOString() : null;

    const input: VoucherInput = { planId, maxRedemptions, expiresAt, note, isActive };
    // Only sent when creating and only when filled in: the backend
    // generates one otherwise, and a code cannot be changed once it
    // exists because it may already be printed or sent.
    if (!editing && code.trim()) input.code = code.trim();

    startTransition(async () => {
      const result = editing
        ? await updateVoucher(voucher!.id, input)
        : await createVoucher(input);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(editing ? "Voucher updated" : `Voucher ${result.data.code} created`);
      setOpen(false);
      if (!editing) setCode("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit voucher" : "New voucher"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "The code itself cannot be changed — it may already be in someone's hands. Switch it off instead."
              : "A code that grants a plan without payment."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="plan">Plan</Label>
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger id="plan">
                <SelectValue placeholder="Choose a plan" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((plan) => (
                  <SelectItem key={plan.id} value={plan.id}>
                    {plan.name} — {plan.durationDays} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!editing && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="Leave empty to generate one"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Generated codes avoid characters people confuse when typing — no O/0 or I/1.
              </p>
            </div>
          )}

          <fieldset className="flex flex-col gap-2">
            <Label>How many times it can be used</Label>
            <div className="flex flex-col gap-2 rounded-lg border border-white/8 p-3">
              {(
                [
                  ["once", "Once only", "The first person to redeem it uses it up."],
                  ["limited", "A set number of times", "Shared with a group, capped."],
                  ["unlimited", "Unlimited", "Anyone with the code, until it expires or is switched off."],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="radio"
                    name="usage"
                    className="mt-1 accent-primary"
                    checked={usage === value}
                    onChange={() => setUsage(value)}
                  />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">{hint}</span>
                  </span>
                </label>
              ))}
              {usage === "limited" && (
                <Input
                  type="number"
                  min={2}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  className="mt-1 w-32"
                  aria-label="Maximum redemptions"
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Each customer can redeem a given code once, whichever option is chosen.
            </p>
          </fieldset>

          <div className="flex flex-col gap-2">
            <Label htmlFor="expires">Expires on</Label>
            <Input
              id="expires"
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Leave empty for no expiry.</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="note">Note</Label>
            <Input
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What this batch is for — only you see this"
            />
          </div>

          {editing && (
            <label className="flex items-center gap-2.5 text-sm">
              <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(v === true)} />
              Active — uncheck to stop it being redeemed without deleting it
            </label>
          )}

          <DialogFooter>
            <Button type="submit" disabled={pending || !planId}>
              {pending ? "Saving..." : editing ? "Save changes" : "Create voucher"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
