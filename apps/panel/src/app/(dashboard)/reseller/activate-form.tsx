"use client";

import { useState, useTransition, type FormEvent } from "react";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ResellerBalance } from "@/lib/types";
import { activateForCustomer } from "./actions";
import { balanceLabel, canMintFrom, planToActivate } from "./balance";

type Outcome = { ok: boolean; text: string } | null;

/**
 * Puts a plan straight onto a customer's account, for the customer who
 * cannot redeem a code themselves.
 *
 * What happened is written under the form and stays there, rather than
 * shown in a toast like the rest of this page. A token is spent here
 * with no code to look at afterwards, and a refusal can run to a couple
 * of sentences about what to do next -- neither should vanish after
 * four seconds.
 */
export function ActivateForm({ balances }: { balances: ResellerBalance[] }) {
  const [picked, setPicked] = useState("");
  const [email, setEmail] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [pending, startTransition] = useTransition();

  // Only what can be spent from: a plan with no tokens, or one that is
  // no longer offered, is not a choice here.
  const spendable = balances.filter(canMintFrom);
  const planId = planToActivate(balances, picked);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const customerEmail = email.trim();
    // The server refuses a repeat as well. This only spares the round trip.
    if (pending || !planId || !customerEmail) return;

    setOutcome(null);
    startTransition(async () => {
      const result = await activateForCustomer(planId, customerEmail);
      if (!result.ok) {
        // The backend's own words: it knows whether a token was spent.
        setOutcome({ ok: false, text: result.error });
        return;
      }
      setEmail("");
      setOutcome({
        ok: true,
        text: `${result.data.plan.name} is now active on ${result.data.customerEmail}. One ${result.data.plan.name} token was used.`,
      });
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-base font-semibold">Activate on a customer&apos;s account</h2>
        <p className="text-sm text-muted-foreground">
          Puts the plan straight onto an account that already exists, so the customer does not need
          a code. Spends one token.
        </p>
      </div>

      {spendable.length === 0 ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          You have no tokens to activate a plan with. Ask the operator to top up your balance.
        </p>
      ) : null}

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="activate-email">Customer email</Label>
            <Input
              id="activate-email"
              type="email"
              required
              autoComplete="off"
              placeholder="them@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">The address they sign in with.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Plan</Label>
            <Select value={planId} onValueChange={setPicked} disabled={spendable.length === 0}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a plan" />
              </SelectTrigger>
              <SelectContent>
                {spendable.map((b) => (
                  <SelectItem key={b.plan.id} value={b.plan.id}>
                    {balanceLabel(b)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending || !planId} className="gap-2">
            <UserCheck className="size-4" />
            {pending ? "Activating…" : "Activate"}
          </Button>
        </div>

        {outcome ? (
          <p
            role={outcome.ok ? "status" : "alert"}
            className={
              outcome.ok
                ? "rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200"
                : "rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
            }
          >
            {outcome.text}
          </p>
        ) : null}
      </form>
    </Card>
  );
}
