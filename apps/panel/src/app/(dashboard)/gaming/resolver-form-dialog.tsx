"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createGamingResolver, updateGamingResolver } from "./actions";
import type { GamingResolver, Node } from "@/lib/types";
import { isIpAddress, isPlausibleHostname } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ResolverFormDialog({
  resolver,
  nodes,
  trigger,
}: {
  resolver?: GamingResolver;
  nodes: Node[];
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(resolver);

  function handleSubmit(formData: FormData) {
    const nodeId = String(formData.get("nodeId") ?? "");
    if (!nodeId) {
      toast.error("Pick the node this resolver runs on.");
      return;
    }

    const dohHost = String(formData.get("dohHost") ?? "").trim();
    if (!isPlausibleHostname(dohHost)) {
      toast.error(
        "The DoH host must be a hostname, not an address -- the client dials it over TLS and needs a name to present.",
      );
      return;
    }

    const proxyIp = String(formData.get("proxyIp") ?? "").trim();
    if (!isIpAddress(proxyIp)) {
      toast.error("The proxy address must be a literal IP -- this is what the resolver answers with.");
      return;
    }

    const dohPort = Number(formData.get("dohPort"));
    const proxyPort = Number(formData.get("proxyPort"));
    if (!Number.isInteger(dohPort) || dohPort < 1 || dohPort > 65535) {
      toast.error("DoH port must be between 1 and 65535.");
      return;
    }
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      toast.error("Proxy port must be between 1 and 65535.");
      return;
    }

    startTransition(async () => {
      const input = {
        nodeId,
        dohHost,
        dohPort,
        proxyIp,
        proxyPort,
        isEnabled: formData.get("isEnabled") === "on",
      };

      const result = isEdit
        ? await updateGamingResolver(resolver!.id, input)
        : await createGamingResolver(input);

      if (result.ok) {
        toast.success(isEdit ? "Resolver updated" : "Resolver created");
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
          <DialogTitle>{isEdit ? "Edit resolver" : "New resolver"}</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="nodeId">Node</Label>
            <Select name="nodeId" defaultValue={resolver?.nodeId}>
              <SelectTrigger id="nodeId">
                <SelectValue placeholder="Select a node" />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>
                    {node.name} ({node.region})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-[1fr_7rem] gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="dohHost">DoH host</Label>
              <Input
                id="dohHost"
                name="dohHost"
                defaultValue={resolver?.dohHost ?? ""}
                placeholder="fallback.example.com"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dohPort">Port</Label>
              <Input
                id="dohPort"
                name="dohPort"
                type="number"
                min={1}
                max={65535}
                defaultValue={resolver?.dohPort ?? 443}
                required
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Where the client sends its DNS queries, over HTTPS. A name that looks like ours is a name
            that gets blocked, so this should be the node&apos;s existing fallback host rather than
            anything recognisable -- the same machinery that already keeps the node from looking like
            a VPN.
          </p>

          <div className="grid grid-cols-[1fr_7rem] gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="proxyIp">Proxy address</Label>
              <Input
                id="proxyIp"
                name="proxyIp"
                defaultValue={resolver?.proxyIp ?? ""}
                placeholder="203.0.113.10"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="proxyPort">Port</Label>
              <Input
                id="proxyPort"
                name="proxyPort"
                type="number"
                min={1}
                max={65535}
                defaultValue={resolver?.proxyPort ?? 443}
                required
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The address this resolver answers with for a carried hostname. Everything else it is
            asked about it answers truthfully, so only the listed launcher and store hosts arrive
            here.
          </p>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isEnabled" defaultChecked={resolver?.isEnabled ?? true} />
            Enabled
          </label>
          <p className="text-xs text-muted-foreground">
            Enabling it is not the same as it working. A resolver is handed to a client only once it
            has confirmed, and this box does not confirm anything.
          </p>

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
