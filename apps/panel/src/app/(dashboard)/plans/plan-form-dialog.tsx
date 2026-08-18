"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { createPlan, updatePlan } from "./actions";
import type { Protocol, Route, SubscriptionPlan } from "@/lib/types";
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
  const downRef = useRef<HTMLInputElement>(null);
  const upRef = useRef<HTMLInputElement>(null);
  const [caps, setCaps] = useState(Boolean(plan?.maxDownloadMbps || plan?.maxUploadMbps));
  // Read from the stored plan for the two warnings below; no longer
  // editable here, because the routes decide it.
  const protocols: Protocol[] = plan?.protocolsAllowed ?? [];
  // Xray multiplexes every user through one process with no per-user
  // address, so there is nothing to shape per customer. Saying so beats
  // showing a cap that quietly does nothing on those protocols.
  const unshapeable = protocols.filter((p) => p.startsWith("XRAY"));
  // Device limits are counted per protocol, and the Xray family stopped
  // being countable when the access log came off the nodes. Shadowsocks
  // belongs here despite its name: it is served by Xray too, so its
  // sessions came from the same log.
  const uncountable = protocols.filter((p) => p.startsWith("XRAY") || p === "SHADOWSOCKS");
  const [pending, startTransition] = useTransition();
  const [unlimitedData, setUnlimitedData] = useState(plan ? plan.dataCapBytes === null : false);
  const isEdit = Boolean(plan);

  // Every route is offered on every plan, relay or direct. The plan is
  // whatever an operator ticked and nothing else -- there is no longer a
  // relay/direct rule deciding what may appear here.
  const [selectedRoutes, setSelectedRoutes] = useState<string[]>(
    plan?.allowedRoutes.map((r) => r.id) ?? [],
  );
  const eligibleRoutes = routes;

  function handleSubmit(formData: FormData) {
    // Null, not a very large number. An unlimited plan and a plan with
    // a huge cap are different things, and only the first one survives
    // somebody deciding later to raise the "big" number.
    let dataCapBytes: string | null = null;
    if (!unlimitedData) {
      const parsed = parseBytesInput(String(formData.get("dataCap") ?? ""));
      if (!parsed) {
        toast.error('Data cap must look like "10GB", "512MB", etc.');
        return;
      }
      dataCapBytes = parsed;
    }

    const maxConn = String(formData.get("maxConcurrentConnections") ?? "").trim();
    const downMbps = String(formData.get("maxDownloadMbps") ?? "").trim();
    const upMbps = String(formData.get("maxUploadMbps") ?? "").trim();
    const defaultRouteId = String(formData.get("defaultRouteId") ?? "");

    startTransition(async () => {
      const input = {
        name: String(formData.get("name") ?? ""),
        dataCapBytes,
        durationDays: Number(formData.get("durationDays")),
        priceUsd: Number(formData.get("priceUsd")),
        maxConcurrentConnections: maxConn ? Number(maxConn) : undefined,
        // Blank means uncapped. Sent as undefined rather than 0, which the
        // node would read as a limit of zero and cut the customer off.
        maxDownloadMbps: downMbps ? Number(downMbps) : undefined,
        maxUploadMbps: upMbps ? Number(upMbps) : undefined,
        isActive: formData.get("isActive") === "on",
        isPurchasable: formData.get("isPurchasable") === "on",
        defaultRouteId: defaultRouteId === NO_DEFAULT_ROUTE ? undefined : defaultRouteId,
        // Always sent, including as an empty array -- that is what
        // clears a restriction back to "every eligible route". Omitting
        // it would mean "leave unchanged", so an admin unticking the
        // last box would see nothing happen.
        allowedRouteIds: formData.getAll("allowedRouteIds") as string[],
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
                defaultValue={
                  plan?.dataCapBytes ? formatBytes(plan.dataCapBytes).replace(" ", "") : ""
                }
                disabled={unlimitedData}
                required={!unlimitedData}
              />
              {/* Metered and unmetered plans coexist on purpose: a relay
                  through an Iranian VPS is capped because that VPS's own
                  allowance is small, a direct foreign route need not be. */}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={unlimitedData}
                  onCheckedChange={(value) => setUnlimitedData(value === true)}
                />
                Unlimited traffic
              </label>
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
              {/* Counted from the nodes' Xray access log, which is the only
                  place Xray reports sessions at all. Worth knowing that
                  the limit lives or dies with that log: it was off for a
                  day in August and these numbers meant nothing while it
                  was. */}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="maxDownloadMbps">Download limit (Mbit/s)</Label>
              <Input
                id="maxDownloadMbps"
                name="maxDownloadMbps"
                ref={downRef}
                type="number"
                min={1}
                placeholder="Unlimited"
                defaultValue={plan?.maxDownloadMbps ?? ""}
                onChange={(e) => setCaps(Boolean(e.target.value) || Boolean(upRef.current?.value))}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="maxUploadMbps">Upload limit (Mbit/s)</Label>
              <Input
                id="maxUploadMbps"
                name="maxUploadMbps"
                type="number"
                min={1}
                placeholder="Unlimited"
                defaultValue={plan?.maxUploadMbps ?? ""}
                ref={upRef}
                onChange={(e) => setCaps(Boolean(e.target.value) || Boolean(downRef.current?.value))}
              />
            </div>
          </div>
          {caps && unshapeable.length > 0 ? (
            <p className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-xs text-highlight">
              Speed limits won&apos;t apply to {unshapeable.join(", ")}. Those protocols share a single
              connection on the server with no per-customer address to limit, so a cap there would slow
              every customer on the node at once. WireGuard and OpenVPN are limited normally.
            </p>
          ) : null}
          {/* Empty means every eligible route, not none. The count in the
              hint is there so the admin can see which of the two states
              they are in without counting checkboxes. */}
          <div className="flex flex-col gap-2">
            <Label>Routes</Label>
            <p className="text-xs text-muted-foreground">
              {selectedRoutes.length === 0
                ? "None selected -- this plan serves nothing. Tick the routes customers on it should get."
                : `Served by ${selectedRoutes.length} route${selectedRoutes.length === 1 ? "" : "s"}. Routes added later won't be included until you tick them here.`}
            </p>
            <div className="flex flex-col gap-2">
              {eligibleRoutes.length === 0 ? (
                <p className="text-xs text-muted-foreground">No routes exist yet.</p>
              ) : (
                eligibleRoutes.map((route) => (
                  <label key={route.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      name="allowedRouteIds"
                      value={route.id}
                      defaultChecked={plan?.allowedRoutes.some((r) => r.id === route.id)}
                      onCheckedChange={(checked) =>
                        setSelectedRoutes((current) =>
                          checked ? [...current, route.id] : current.filter((id) => id !== route.id),
                        )
                      }
                    />
                    <span>{route.name}</span>
                    {!route.isEnabled ? (
                      <span className="text-xs text-muted-foreground">(disabled)</span>
                    ) : null}
                  </label>
                ))
              )}
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
          {/* Two flags, because one was doing two jobs and broke the
              free trial: the Trial plan was deactivated to hide it from
              customers, and an inactive plan cannot have subscriptions
              created on it, so every trial signup failed silently. */}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isActive" defaultChecked={plan?.isActive ?? true} />
            Active (the plan works -- subscriptions and trials can use it)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isPurchasable" defaultChecked={plan?.isPurchasable ?? true} />
            Show in the purchase list (untick to keep it usable but hidden)
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
