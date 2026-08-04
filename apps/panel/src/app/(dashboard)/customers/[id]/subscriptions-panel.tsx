"use client";

import { useState, useTransition } from "react";
import { CalendarPlus, MoreHorizontal, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Subscription, SubscriptionPlan, SubscriptionStatus } from "@/lib/types";
import {
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
      <CardHeader>
        <CardTitle className="text-base">Subscriptions</CardTitle>
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
