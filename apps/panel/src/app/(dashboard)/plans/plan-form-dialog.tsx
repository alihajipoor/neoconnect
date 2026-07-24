"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createPlan, updatePlan } from "./actions";
import type { Protocol, Route, SubscriptionPlan } from "@/lib/types";
import { ALL_PROTOCOLS } from "@/lib/types";
import { PROTOCOL_LABELS } from "@/lib/protocol-labels";
import { formatBytes, parseBytesInput } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const NO_DEFAULT_ROUTE = "none";

export function PlanFormDialog({
  plan,
  routes,
  trigger,
}: {
  plan?: SubscriptionPlan;
  routes: Route[];
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(plan);

  function handleSubmit(formData: FormData) {
    const dataCapInput = String(formData.get("dataCap") ?? "");
    const dataCapBytes = parseBytesInput(dataCapInput);
    if (!dataCapBytes) {
      toast.error('Data cap must look like "10GB", "512MB", etc.');
      return;
    }

    const protocolsAllowed = formData.getAll("protocolsAllowed") as Protocol[];
    if (protocolsAllowed.length === 0) {
      toast.error("Select at least one protocol.");
      return;
    }

    const maxConn = String(formData.get("maxConcurrentConnections") ?? "").trim();
    const defaultRouteId = String(formData.get("defaultRouteId") ?? "");

    startTransition(async () => {
      const input = {
        name: String(formData.get("name") ?? ""),
        dataCapBytes,
        durationDays: Number(formData.get("durationDays")),
        priceUsd: Number(formData.get("priceUsd")),
        maxConcurrentConnections: maxConn ? Number(maxConn) : undefined,
        protocolsAllowed,
        isActive: formData.get("isActive") === "on",
        defaultRouteId: defaultRouteId === NO_DEFAULT_ROUTE ? undefined : defaultRouteId,
      };

      const result = isEdit ? await updatePlan(plan!.id, input) : await createPlan(input);

      if (result.ok) {
        toast.success(isEdit ? "Plan updated" : "Plan created");
        setOpen(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit plan" : "New plan"}</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" defaultValue={plan?.name} required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="dataCap">Data cap</Label>
              <Input
                id="dataCap"
                name="dataCap"
                placeholder="10GB"
                defaultValue={plan ? formatBytes(plan.dataCapBytes).replace(" ", "") : ""}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="durationDays">Duration (days)</Label>
              <Input
                id="durationDays"
                name="durationDays"
                type="number"
                min={1}
                defaultValue={plan?.durationDays}
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="priceUsd">Price (USD)</Label>
              <Input
                id="priceUsd"
                name="priceUsd"
                type="number"
                min={0}
                step="0.01"
                defaultValue={plan?.priceUsd}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="maxConcurrentConnections">Max connections (optional)</Label>
              <Input
                id="maxConcurrentConnections"
                name="maxConcurrentConnections"
                type="number"
                min={1}
                defaultValue={plan?.maxConcurrentConnections ?? ""}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Protocols</Label>
            <div className="flex flex-col gap-2">
              {ALL_PROTOCOLS.map((protocol) => (
                <label key={protocol} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    name="protocolsAllowed"
                    value={protocol}
                    defaultChecked={plan?.protocolsAllowed.includes(protocol)}
                  />
                  {PROTOCOL_LABELS[protocol]}
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="defaultRouteId">Default route (for purchases)</Label>
            <Select name="defaultRouteId" defaultValue={plan?.defaultRouteId ?? NO_DEFAULT_ROUTE}>
              <SelectTrigger id="defaultRouteId">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEFAULT_ROUTE}>None -- purchases won&apos;t get provisioned</SelectItem>
                {routes.map((route) => (
                  <SelectItem key={route.id} value={route.id}>
                    {route.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Which server a customer purchasing this plan gets connection credentials on once payment
              clears. Required for self-service purchases to actually work.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isActive" defaultChecked={plan?.isActive ?? true} />
            Active (visible for new subscriptions)
          </label>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
