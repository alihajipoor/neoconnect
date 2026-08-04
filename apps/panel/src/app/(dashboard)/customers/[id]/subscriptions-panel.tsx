"use client";

import { useState, useTransition } from "react";
import { ArrowLeftRight, CalendarPlus, MoreHorizontal, Pause, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Subscription, SubscriptionPlan, SubscriptionStatus } from "@/lib/types";
import {
  assignPlan,
  changeSubscriptionPlan,
  deleteSubscription,
  extendSubscription,
  resetSubscriptionUsage,
  setSubscriptionStatus,
} from "./actions";
import { formatBytes } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DeleteConfirm } from "@/components/dashboard/delete-confirm";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Common extensions, so the ordinary case is one click.
 *
 * A free-text box would be more flexible and slower for the thing an
 * operator actually does forty times a week. */
const EXTENSIONS = [7, 30, 90];

export function SubscriptionsPanel({
  customerId,
  subscriptions,
  plans,
}: {
  customerId: string;
  subscriptions: Subscription[];
  plans: SubscriptionPlan[];
}) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  function run(id: string, label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    setBusyId(id);
    startTransition(async () => {
      const result = await action();
      setBusyId(null);
      if (result.ok) toast.success(label);
      else toast.error(result.error ?? "That didn't work");
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">Subscriptions</CardTitle>
        {/* Assigning a plan by hand is the operator's equivalent of a
            purchase, so it belongs here rather than behind a row menu
            that only exists once there is already a subscription. */}
        <AssignPlanButton customerId={customerId} plans={plans} />
      </CardHeader>
      <CardContent>
        {subscriptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No subscriptions. Nothing to manage yet.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {subscriptions.map((subscription) => {
              const plan = plans.find((p) => p.id === subscription.planId);
              const used = Number(subscription.dataUsedBytes);
              const cap =
                subscription.dataCapBytes === null ? null : Number(subscription.dataCapBytes);
              const percent = cap && cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
              const busy = pending && busyId === subscription.id;
              const active = subscription.status === "ACTIVE";

              return (
                <div
                  key={subscription.id}
                  className="flex flex-col gap-3 rounded-lg border border-white/8 bg-card/40 p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="font-medium">{plan?.name ?? "Unknown plan"}</span>
                      <Badge variant={active ? "default" : "outline"}>{subscription.status}</Badge>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {/* The two actions worth a real button. Everything
                          rarer lives behind the menu, so the common case
                          does not have to be hunted for. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        className="border border-white/10"
                        onClick={() =>
                          run(
                            subscription.id,
                            active ? "Suspended" : "Resumed",
                            () =>
                              setSubscriptionStatus(
                                customerId,
                                subscription.id,
                                (active ? "SUSPENDED" : "ACTIVE") as SubscriptionStatus,
                              ),
                          )
                        }
                      >
                        {active ? <Pause /> : <Play />}
                        {active ? "Suspend" : "Resume"}
                      </Button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" disabled={busy} aria-label="More">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {EXTENSIONS.map((days) => (
                            <DropdownMenuItem
                              key={days}
                              onSelect={() =>
                                run(subscription.id, `Extended by ${days} days`, () =>
                                  extendSubscription(customerId, subscription.id, days),
                                )
                              }
                            >
                              <CalendarPlus /> Extend {days} days
                            </DropdownMenuItem>
                          ))}
                          {plans
                            .filter((p) => p.isActive && p.id !== subscription.planId)
                            .map((p) => (
                              <DropdownMenuItem
                                key={p.id}
                                onSelect={() =>
                                  run(subscription.id, `Moved to ${p.name}`, () =>
                                    changeSubscriptionPlan(customerId, subscription.id, p.id),
                                  )
                                }
                              >
                                <ArrowLeftRight /> Move to {p.name}
                              </DropdownMenuItem>
                            ))}
                          <DropdownMenuItem
                            onSelect={() =>
                              run(subscription.id, "Usage reset", () =>
                                resetSubscriptionUsage(customerId, subscription.id),
                              )
                            }
                          >
                            <RotateCcw /> Reset data usage
                          </DropdownMenuItem>
                          <DeleteConfirm
                            title="Delete this subscription?"
                            description="Its credentials are removed from the nodes too. This cannot be undone."
                            onConfirm={() => deleteSubscription(customerId, subscription.id)}
                            successMessage="Subscription deleted"
                            trigger={
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={(e) => e.preventDefault()}
                              >
                                <Trash2 /> Delete
                              </DropdownMenuItem>
                            }
                          />
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      Data{" "}
                      <span className="text-foreground">
                        {formatBytes(String(used))} / {cap === null ? "Unlimited" : formatBytes(String(cap))}
                      </span>
                    </span>
                    <span>
                      Expires{" "}
                      <span className="text-foreground">
                        {new Date(subscription.expireAt).toLocaleDateString()}
                      </span>
                    </span>
                  </div>

                  {/* Only drawn when there is a proportion to draw. An
                      unlimited plan has no bar to fill. */}
                  {cap !== null && cap > 0 && (
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
                      <div
                        className="h-full rounded-full transition-[width]"
                        style={{
                          width: `${Math.max(percent, 1.5)}%`,
                          background:
                            percent >= 80
                              ? "linear-gradient(90deg,#f59e0b,#ef4444)"
                              : "linear-gradient(90deg,var(--primary),var(--highlight))",
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Assigning a plan, for a customer who has none or needs another.
 *
 * A menu of active plans rather than a dialog with a select: there is
 * exactly one decision to make and a dialog would add two clicks to
 * it. */
function AssignPlanButton({
  customerId,
  plans,
}: {
  customerId: string;
  plans: SubscriptionPlan[];
}) {
  const [pending, startTransition] = useTransition();
  const active = plans.filter((p) => p.isActive);

  if (active.length === 0) {
    return <span className="text-xs text-muted-foreground">No active plans to assign</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" disabled={pending}>
          <Plus /> Assign plan
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {active.map((plan) => (
          <DropdownMenuItem
            key={plan.id}
            onSelect={() =>
              startTransition(async () => {
                const result = await assignPlan(customerId, plan.id);
                if (result.ok) toast.success(`Assigned ${plan.name}`);
                else toast.error(result.error);
              })
            }
          >
            {plan.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
