"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { sendAnnouncementAction } from "./actions";
import type { Node, ProtocolConfig, Route, SubscriptionPlan, SubscriptionStatus } from "@/lib/types";
import { isRetiredRoute, routeServers } from "@/lib/retired";
import { RetiredSwitch } from "@/components/dashboard/retired-switch";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STATUSES: SubscriptionStatus[] = ["ACTIVE", "SUSPENDED", "EXPIRED", "CANCELLED"];

export function AnnouncementForm({
  plans,
  routes,
  protocolConfigs,
  nodes,
}: {
  plans: SubscriptionPlan[];
  routes: Route[];
  protocolConfigs: ProtocolConfig[];
  nodes: Node[];
}) {
  const [pending, startTransition] = useTransition();
  // Retired servers' routes are hidden with CSS, not removed, so a box
  // ticked before hiding them is still sent.
  const [showRetired, setShowRetired] = useState(false);
  const retiredIds = new Set(
    routes.filter((r) => isRetiredRoute(routeServers(r, protocolConfigs, nodes))).map((r) => r.id),
  );

  function handleSubmit(formData: FormData) {
    const subject = String(formData.get("subject") ?? "").trim();
    const body = String(formData.get("body") ?? "").trim();
    const statuses = formData.getAll("statuses").map(String) as SubscriptionStatus[];
    const planIds = formData.getAll("planIds").map(String);
    const routeIds = formData.getAll("routeIds").map(String);

    if (!subject || !body) {
      toast.error("Subject and body are required.");
      return;
    }

    startTransition(async () => {
      const result = await sendAnnouncementAction({
        subject,
        body,
        statuses: statuses.length ? statuses : undefined,
        planIds: planIds.length ? planIds : undefined,
        routeIds: routeIds.length ? routeIds : undefined,
      });
      if (result.ok) {
        toast.success(
          result.data.recipientCount > 0
            ? `Queued for ${result.data.recipientCount} recipient(s)`
            : "No customers matched these filters -- nothing was sent",
        );
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card className="border-white/10 bg-card/80">
      <CardHeader>
        <CardTitle className="text-lg">Compose</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="subject">Subject</Label>
            <Input id="subject" name="subject" required autoFocus />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="body">Body</Label>
            <Textarea id="body" name="body" rows={6} required />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Subscription status</legend>
            <div className="flex flex-wrap gap-4">
              {STATUSES.map((status) => (
                <label key={status} className="flex items-center gap-2 text-sm">
                  <Checkbox name="statuses" value={status} />
                  {status}
                </label>
              ))}
            </div>
          </fieldset>

          {plans.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Plan</legend>
              <div className="flex flex-wrap gap-4">
                {plans.map((plan) => (
                  <label key={plan.id} className="flex items-center gap-2 text-sm">
                    <Checkbox name="planIds" value={plan.id} />
                    {plan.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {routes.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Route / server</legend>
              <RetiredSwitch
                count={retiredIds.size}
                noun="servers' routes"
                checked={showRetired}
                onCheckedChange={setShowRetired}
              />
              <div className="flex flex-wrap gap-4">
                {routes.map((route) => (
                  <label
                    key={route.id}
                    className={
                      retiredIds.has(route.id) && !showRetired ? "hidden" : "flex items-center gap-2 text-sm"
                    }
                  >
                    <Checkbox name="routeIds" value={route.id} />
                    {route.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <Button type="submit" disabled={pending} className="self-start">
            {pending ? "Sending..." : "Send"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
