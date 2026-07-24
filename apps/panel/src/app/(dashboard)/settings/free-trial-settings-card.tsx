"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { updateFreeTrialSettingsAction } from "./actions";
import type { FreeTrialSettings, Route, SubscriptionPlan } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function FreeTrialSettingsCard({
  settings,
  plans,
  routes,
}: {
  settings: FreeTrialSettings;
  plans: SubscriptionPlan[];
  routes: Route[];
}) {
  const [pending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    const enabled = formData.get("enabled") === "on";
    const trialPlanId = String(formData.get("trialPlanId") ?? "") || undefined;
    const trialRouteId = String(formData.get("trialRouteId") ?? "") || undefined;

    if (enabled && (!trialPlanId || !trialRouteId)) {
      toast.error("Pick a trial plan and route before enabling free trial mode.");
      return;
    }

    startTransition(async () => {
      const result = await updateFreeTrialSettingsAction({ enabled, trialPlanId, trialRouteId });
      if (result.ok) {
        toast.success("Free trial settings saved");
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card className="border-white/10 bg-card/80">
      <CardHeader>
        <CardTitle className="text-lg">Free trial mode</CardTitle>
        <CardDescription>
          When enabled, new customer signups (from the VPN client apps) automatically get a free trial
          subscription and connection credentials on the plan/route below -- no payment info required.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="enabled" defaultChecked={settings.enabled} />
            Enabled
          </label>
          <div className="flex flex-col gap-2">
            <Label htmlFor="trialPlanId">Trial plan</Label>
            <Select name="trialPlanId" defaultValue={settings.trialPlanId ?? undefined}>
              <SelectTrigger id="trialPlanId">
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
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="trialRouteId">Trial route</Label>
            <Select name="trialRouteId" defaultValue={settings.trialRouteId ?? undefined}>
              <SelectTrigger id="trialRouteId">
                <SelectValue placeholder="Select a route" />
              </SelectTrigger>
              <SelectContent>
                {routes.map((route) => (
                  <SelectItem key={route.id} value={route.id}>
                    {route.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={pending} className="self-start">
            {pending ? "Saving..." : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
