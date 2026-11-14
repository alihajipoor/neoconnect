"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import type { Node, ProtocolConfig, Route, SubscriptionPlan } from "@/lib/types";
import { formatBytes } from "@/lib/utils";
import { PROTOCOL_LABELS } from "@/lib/protocol-labels";
import { deletePlan } from "./actions";
import { PlanFormDialog } from "./plan-form-dialog";
import { DeleteConfirm } from "@/components/dashboard/delete-confirm";
import { PageHeader } from "@/components/dashboard/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function PlansTable({
  plans,
  routes,
  protocolConfigs,
  nodes,
  canManage,
}: {
  plans: SubscriptionPlan[];
  routes: Route[];
  protocolConfigs: ProtocolConfig[];
  nodes: Node[];
  canManage: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Plans"
        description="Subscription tiers customers can purchase."
        actions={canManage && (
          <PlanFormDialog
            routes={routes}
            protocolConfigs={protocolConfigs}
            nodes={nodes}
            trigger={
              <Button size="sm">
                <Plus /> New Plan
              </Button>
            }
          />
        )}
      />
      <div className="rounded-lg border border-white/8 bg-card/40">
        <Table stack>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Data cap</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Protocols</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No plans yet.
                </TableCell>
              </TableRow>
            ) : (
              plans.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell cell="primary" className="font-medium">{plan.name}</TableCell>
                  <TableCell label="Data cap" phoneOrder={3}>
                    {plan.dataCapBytes === null ? (
                      <span className="text-highlight">Unlimited</span>
                    ) : (
                      formatBytes(plan.dataCapBytes)
                    )}
                  </TableCell>
                  <TableCell label="Duration" phoneOrder={2}>{plan.durationDays}d</TableCell>
                  <TableCell label="Price" phoneOrder={1}>${plan.priceUsd}</TableCell>
                  {/* Wraps, unlike the other cells: eight chips on one line
                      pushed the row menu off the right edge below about
                      1900px. */}
                  <TableCell label="Protocols" wide phoneOrder={4} className="min-w-48 whitespace-normal max-lg:whitespace-nowrap">
                    <div className="flex flex-wrap gap-1 max-lg:flex-nowrap max-sm:flex-wrap">
                      {plan.protocolsAllowed.map((p) => (
                        <Badge key={p} variant="outline">
                          {PROTOCOL_LABELS[p]}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell cell="status">
                    <Badge variant={plan.isActive ? "success" : "secondary"}>
                      {plan.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  {canManage && (
                    <TableCell cell="actions">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Row actions">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <PlanFormDialog
                            plan={plan}
                            routes={routes}
                            protocolConfigs={protocolConfigs}
                            nodes={nodes}
                            trigger={
                              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>Edit</DropdownMenuItem>
                            }
                          />
                          <DeleteConfirm
                            trigger={
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={(e) => e.preventDefault()}
                              >
                                Delete
                              </DropdownMenuItem>
                            }
                            title="Delete this plan?"
                            description={`This permanently removes "${plan.name}". Existing subscriptions on this plan will block deletion.`}
                            successMessage="Plan deleted"
                            onConfirm={() => deletePlan(plan.id)}
                          />
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
