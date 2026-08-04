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
  // Tracked so the name can follow the chosen entry, and so a name that
  // contradicts it can be pointed out. See the warning below.
  const [entryId, setEntryId] = useState("");
  const [name, setName] = useState("");

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

  const entryNode = entryId
    ? nodeById(protocolConfigs.find((pc) => pc.id === entryId)?.nodeId ?? "")
    : undefined;

  // The name says one node and the route points at another.
  //
  // This is not hypothetical tidiness. A route called "france-1 /
  // Stealth HTTP" was created against finland1's config and went live:
  // customers choosing France would have been sent to Finland, with
  // nothing reporting an error because the tunnel works perfectly --
  // just not where it claims. Route names are what the location picker
  // shows, so a wrong one is a lie told to every customer who reads it.
  //
  // A warning rather than a block: an operator may have a naming scheme
  // that does not start with the node's name, and refusing to save
  // would be wrong. It only has to be impossible to do *silently*.
  const otherNodeNames = nodes
    .map((n) => n.name)
    .filter((n) => entryNode && n !== entryNode.name);
  const nameContradictsEntry =
    Boolean(entryNode) &&
    name.trim().length > 0 &&
    !name.toLowerCase().includes(entryNode!.name.toLowerCase()) &&
    otherNodeNames.some((other) => name.toLowerCase().includes(other.toLowerCase()));

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
            <Input
              id="name"
              name="name"
              placeholder="e.g. Frankfurt direct"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Shown to customers in the app&apos;s location picker.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="entryProtocolConfigId">Entry (client-facing)</Label>
            <Select
              name="entryProtocolConfigId"
              required
              value={entryId}
              onValueChange={(value) => {
                setEntryId(value);
                // Prefill the name from the chosen entry, but never
                // overwrite something already typed.
                const pc = protocolConfigs.find((c) => c.id === value);
                const node = pc ? nodeById(pc.nodeId) : undefined;
                if (node && name.trim() === "") {
                  setName(`${node.name} / ${PROTOCOL_LABELS[pc!.protocol]}`);
                }
              }}
            >
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
            {nameContradictsEntry && (
              <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                This route is named for a different server than the entry points at. Customers
                choosing it would reach <strong>{entryNode?.name}</strong>. Check the entry, or the
                name.
              </p>
            )}
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
