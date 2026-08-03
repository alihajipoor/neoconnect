"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateReferralSettingsAction } from "./actions";
import type { ReferralSettings, SubscriptionPlan } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** One threshold input.
 *
 * Defined at module scope, not inside the card. A component created
 * during render is a *new* component type on every render, so React
 * unmounts and remounts it -- which in a controlled number input means
 * the field loses focus after each keystroke. Caught by lint before it
 * reached anyone, and it would have read as the form being broken.
 */
function NumberField({
  name,
  label,
  hint,
  max,
  value,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  max: number;
  value: number;
  onChange: (raw: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        type="number"
        min={1}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

type Rules = {
  loyalFriendMonths: number;
  friendsRequired: number;
  friendMonths: number;
  rewardDays: number;
};

export function ReferralSettingsCard({
  settings,
  plans,
}: {
  settings: ReferralSettings;
  plans: SubscriptionPlan[];
}) {
  const [pending, startTransition] = useTransition();
  // Held in state so the sentence below can restate the rules in the
  // operator's own numbers as they change them. Four interacting
  // thresholds is exactly the kind of form where it is easy to save
  // something you did not mean.
  const [rules, setRules] = useState<Rules>({
    loyalFriendMonths: settings.loyalFriendMonths,
    friendsRequired: settings.friendsRequired,
    friendMonths: settings.friendMonths,
    rewardDays: settings.rewardDays,
  });

  function handleSubmit(formData: FormData) {
    const enabled = formData.get("enabled") === "on";
    const rewardPlanId = String(formData.get("rewardPlanId") ?? "") || undefined;

    if (enabled && !rewardPlanId) {
      toast.error("Pick the plan the free time is granted on before enabling referrals.");
      return;
    }

    startTransition(async () => {
      const result = await updateReferralSettingsAction({ enabled, rewardPlanId, ...rules });
      if (result.ok) {
        toast.success("Referral settings saved");
      } else {
        toast.error(result.error);
      }
    });
  }

  const setRule = (name: keyof Rules, raw: string) =>
    setRules((r) => ({ ...r, [name]: Math.max(1, Number(raw) || 1) }));

  return (
    <Card className="border-white/10 bg-card/80">
      <CardHeader>
        <CardTitle className="text-lg">Referral programme</CardTitle>
        <CardDescription>
          Every customer gets a referral code. Once the friends they invite have paid for enough
          subscription time, the inviter is granted free time automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="enabled" defaultChecked={settings.enabled} />
            Enabled
          </label>

          <div className="flex flex-col gap-2">
            <Label htmlFor="rewardPlanId">Reward plan</Label>
            <Select name="rewardPlanId" defaultValue={settings.rewardPlanId ?? undefined}>
              <SelectTrigger id="rewardPlanId">
                <SelectValue placeholder="Select a plan" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((plan) => (
                  <SelectItem key={plan.id} value={plan.id}>
                    {plan.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              What the free time is granted on, rather than whatever plan the inviter happens to be
              using. An inviter already on this plan has their existing subscription extended
              instead of receiving a second one.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              name="loyalFriendMonths"
              label="Months from one friend"
              hint="One reward when a single invited customer reaches this many paid months."
              max={36}
              value={rules.loyalFriendMonths}
              onChange={(raw) => setRule("loyalFriendMonths", raw)}
            />
            <NumberField
              name="friendsRequired"
              label="Friends needed"
              hint="Or this many different invited customers, whichever happens first."
              max={50}
              value={rules.friendsRequired}
              onChange={(raw) => setRule("friendsRequired", raw)}
            />
            <NumberField
              name="friendMonths"
              label="Months each"
              hint="How much each of those friends must have paid for."
              max={36}
              value={rules.friendMonths}
              onChange={(raw) => setRule("friendMonths", raw)}
            />
            <NumberField
              name="rewardDays"
              label="Free days granted"
              hint="How long the reward runs. Separate from the plan's own duration."
              max={365}
              value={rules.rewardDays}
              onChange={(raw) => setRule("rewardDays", raw)}
            />
          </div>

          {/* Read back in plain words before anything is saved. Four
              interacting numbers are easy to mis-set, and the cost of
              getting them wrong is service given away for free. */}
          <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-muted-foreground">
            A customer earns <strong className="text-foreground">{rules.rewardDays} free days</strong>{" "}
            when one friend they invited has paid for{" "}
            <strong className="text-foreground">{rules.loyalFriendMonths} months</strong>, or when{" "}
            <strong className="text-foreground">{rules.friendsRequired} friends</strong> have each
            paid for <strong className="text-foreground">{rules.friendMonths}</strong> — whichever
            comes first. Only paid time counts; trials and rewards do not.
          </p>

          <Button type="submit" disabled={pending} className="self-start">
            {pending ? "Saving..." : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
