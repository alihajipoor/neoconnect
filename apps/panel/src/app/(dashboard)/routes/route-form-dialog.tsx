"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createRoute } from "./actions";
import type { Node, ProtocolConfig } from "@/lib/types";
import { PROTOCOL_LABELS } from "@/lib/protocol-labels";
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

const NO_EXIT = "none";

// Create-only, same reasoning as the other new pages -- the backend has
// no PATCH /routes/:id (a relayed route's exit-side wiring is set up
// once at creation; changing it means removing and recreating).
export function RouteFormDialog({
  protocolConfigs,
  nodes,
  trigger,
}: {
  protocolConfigs: ProtocolConfig[];
  nodes: Node[];
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const nodeById = (id: string) => nodes.find((n) => n.id === id);
  const label = (pc: ProtocolConfig) => {
    const node = nodeById(pc.nodeId);
    return `${node?.name ?? pc.nodeId} — ${PROTOCOL_LABELS[pc.protocol]} — :${pc.listenPort}`;
  };

  // Only Xray VLESS+REALITY on an EXIT-role node is a valid exit leg --
  // see routes.service.ts's SUPPORTED_EXIT_PROTOCOL. Client-side
  // filtering here is just a usability nicety; the backend re-validates
  // this regardless.
  const exitCandidates = protocolConfigs.filter(
    (pc) => pc.protocol === "XRAY_VLESS_REALITY" && nodeById(pc.nodeId)?.role === "EXIT",
  );

  function handleSubmit(formData: FormData) {
    const exitProtocolConfigId = String(formData.get("exitProtocolConfigId") ?? "");

    startTransition(async () => {
      const result = await createRoute({
        name: String(formData.get("name") ?? ""),
        entryProtocolConfigId: String(formData.get("entryProtocolConfigId") ?? ""),
        exitProtocolConfigId: exitProtocolConfigId === NO_EXIT ? undefined : exitProtocolConfigId,
        isEnabled: formData.get("isEnabled") === "on",
      });

      if (result.ok) {
        toast.success("Route created");
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
          <DialogTitle>New route</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" placeholder="e.g. Frankfurt direct" required autoFocus />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="entryProtocolConfigId">Entry (client-facing)</Label>
            <Select name="entryProtocolConfigId" required>
              <SelectTrigger id="entryProtocolConfigId">
                <SelectValue placeholder="Select a protocol config" />
              </SelectTrigger>
              <SelectContent>
                {protocolConfigs.map((pc) => (
                  <SelectItem key={pc.id} value={pc.id}>
                    {label(pc)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="exitProtocolConfigId">Exit (relay target, optional)</Label>
            <Select name="exitProtocolConfigId" defaultValue={NO_EXIT}>
              <SelectTrigger id="exitProtocolConfigId">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_EXIT}>None -- direct route</SelectItem>
                {exitCandidates.map((pc) => (
                  <SelectItem key={pc.id} value={pc.id}>
                    {label(pc)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only VLESS+REALITY configs on EXIT-role nodes can be an exit leg. Leave as &ldquo;None&rdquo;
              for a direct route (client connects straight to the entry).
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isEnabled" defaultChecked />
            Enabled
          </label>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
