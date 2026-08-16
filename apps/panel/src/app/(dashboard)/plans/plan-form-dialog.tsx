"use client";

import { useRef, useState, useTransition } from "react";
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
  const downRef = useRef<HTMLInputElement>(null);
  const upRef = useRef<HTMLInputElement>(null);
  const [caps, setCaps] = useState(Boolean(plan?.maxDownloadMbps || plan?.maxUploadMbps));
  const [protocols, setProtocols] = useState<Protocol[]>(plan?.protocolsAllowed ?? []);
  // Xray multiplexes every user through one process with no per-user
  // address, so there is nothing to shape per customer. Saying so beats
  // showing a cap that quietly does nothing on those protocols.
  const unshapeable = protocols.filter((p) => p.startsWith("XRAY"));
  const [pending, startTransition] = useTransition();
  const [unlimitedData, setUnlimitedData] = useState(plan ? plan.dataCapBytes === null : false);
  const isEdit = Boolean(plan);

  // Only routes on this plan's side of the relay/direct split can ever
  // serve it, so only those are offered. A relay-only plan is served by
  // relayed routes and nothing else, and the inverse holds for every
  // other plan -- selecting across that line would grant nothing, since
  // the selection narrows what the policy permits rather than widening
  // it. New plans default to the non-relay side, matching relayOnly's
  // own default.
  const [selectedRoutes, setSelectedRoutes] = useState<string[]>(
    plan?.allowedRoutes.map((r) => r.id) ?? [],
  );
  const wantsRelay = plan?.relayOnly ?? false;
  const eligibleRoutes = routes.filter((route) => (route.exitProtocolConfigId !== null) === wantsRelay);
  const hiddenRouteCount = routes.length - eligibleRoutes.length;

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

    const protocolsAllowed = formData.getAll("protocolsAllowed") as Protocol[];
    if (protocolsAllowed.length === 0) {
      toast.error("Select at least one protocol.");
      return;
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
        protocolsAllowed,
        isActive: formData.get("isActive") === "on",
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
          <div className="flex flex-col gap-2">
            <Label>Protocols</Label>
            <div className="flex flex-col gap-2">
              {ALL_PROTOCOLS.map((protocol) => (
                <label key={protocol} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    name="protocolsAllowed"
                    value={protocol}
                    defaultChecked={plan?.protocolsAllowed.includes(protocol)}
                    onCheckedChange={(checked) =>
                      setProtocols((current) =>
                        checked ? [...current, protocol] : current.filter((p) => p !== protocol),
                      )
                    }
                  />
                  {PROTOCOL_LABELS[protocol]}
                </label>
              ))}
            </div>
          </div>
          {/* Empty means every eligible route, not none. The count in the
              hint is there so the admin can see which of the two states
              they are in without counting checkboxes. */}
          <div className="flex flex-col gap-2">
            <Label>Routes</Label>
            <p className="text-xs text-muted-foreground">
              {selectedRoutes.length === 0
                ? "None selected -- this plan uses every route its protocols allow, including ones added later."
                : `Restricted to ${selectedRoutes.length} route${selectedRoutes.length === 1 ? "" : "s"}. Routes added later won't be included until you tick them here.`}
            </p>
            <div className="flex flex-col gap-2">
              {eligibleRoutes.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No {plan?.relayOnly ? "relay" : "direct"} routes exist yet.
                </p>
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
            {/* Routes on the wrong side of the relay split are hidden
                rather than shown-and-ignored: ticking one would grant
                nothing, since the selection narrows what the policy
                already permits and never widens it. */}
            {hiddenRouteCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                {hiddenRouteCount} {plan?.relayOnly ? "direct" : "relay"} route
                {hiddenRouteCount === 1 ? " is" : "s are"} not listed -- this plan is served only by{" "}
                {plan?.relayOnly ? "relay" : "direct"} routes.
              </p>
            ) : null}
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
