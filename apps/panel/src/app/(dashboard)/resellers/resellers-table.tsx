"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ResellerSummary, SubscriptionPlan } from "@/lib/types";
import { setResellerBalance } from "./actions";

export function ResellersTable({
  resellers,
  plans,
}: {
  resellers: ResellerSummary[];
  plans: SubscriptionPlan[];
}) {
  const [pending, startTransition] = useTransition();
  // Keyed by reseller+plan so several boxes can be edited before any is
  // saved, without them sharing state.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (resellers.length === 0) {
    return (
      <Card className="p-6">
        <h2 className="text-base font-semibold">No resellers yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Create an admin account with the <strong>RESELLER</strong> role on the Admins page. They
          appear here once they exist, and you can then grant them capacity per plan.
        </p>
      </Card>
    );
  }

  function save(resellerId: string, planId: string, raw: string) {
    const balance = Number(raw);
    if (!Number.isInteger(balance) || balance < 0) {
      toast.error("Enter a whole number, zero or more");
      return;
    }
    startTransition(async () => {
      const result = await setResellerBalance(resellerId, planId, balance);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Balance updated");
      setDrafts((d) => {
        const next = { ...d };
        delete next[`${resellerId}:${planId}`];
        return next;
      });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        A balance is how many codes of that plan the reseller may still generate. Each code they
        create spends one; deleting an unredeemed one gives it back. Values are absolute — set the
        new total, not the amount to add.
      </p>

      {resellers.map((reseller) => {
        const byPlan = new Map(reseller.balances.map((b) => [b.plan.id, b.balance]));
        return (
          <Card key={reseller.id} className="p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold">{reseller.email}</h2>
              <span className="text-xs text-muted-foreground">
                {reseller.vouchersIssued} {reseller.vouchersIssued === 1 ? "code" : "codes"} issued
              </span>
            </div>

            <div className="mt-4 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
              {plans.map((plan) => {
                const key = `${reseller.id}:${plan.id}`;
                const current = byPlan.get(plan.id) ?? 0;
                const draft = drafts[key];
                const dirty = draft !== undefined && Number(draft) !== current;
                return (
                  <div key={plan.id} className="flex flex-col gap-1.5">
                    <label className="text-xs text-muted-foreground" htmlFor={key}>
                      {plan.name}
                    </label>
                    <div className="flex gap-2">
                      <Input
                        id={key}
                        type="number"
                        min={0}
                        value={draft ?? String(current)}
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [key]: e.target.value }))
                        }
                        className="tabular-nums"
                      />
                      <Button
                        size="sm"
                        variant={dirty ? "default" : "secondary"}
                        disabled={pending || !dirty}
                        onClick={() => save(reseller.id, plan.id, draft ?? String(current))}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
