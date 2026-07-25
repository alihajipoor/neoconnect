"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createProtocolConfig } from "./actions";
import type { Node, Protocol } from "@/lib/types";
import { ALL_PROTOCOLS } from "@/lib/types";
import { DEFAULT_PROTOCOL_PORT, PROTOCOL_LABELS } from "@/lib/protocol-labels";
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

// Create-only; editing an existing config lives in
// ProtocolConfigEditDialog, which deliberately can't change node or
// protocol (both are baked into already-provisioned ProtocolUsers).
export function ProtocolConfigFormDialog({ nodes, trigger }: { nodes: Node[]; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [protocol, setProtocol] = useState<Protocol>("XRAY_VLESS_REALITY");
  const [listenPort, setListenPort] = useState(DEFAULT_PROTOCOL_PORT.XRAY_VLESS_REALITY);

  function handleSubmit(formData: FormData) {
    const rawParams = String(formData.get("publicParamsJson") ?? "").trim();
    let publicParamsJson: Record<string, unknown> = {};
    if (rawParams) {
      try {
        publicParamsJson = JSON.parse(rawParams) as Record<string, unknown>;
      } catch {
        toast.error("Public params must be valid JSON (or leave it empty)");
        return;
      }
    }

    startTransition(async () => {
      const result = await createProtocolConfig({
        nodeId: String(formData.get("nodeId") ?? ""),
        protocol: formData.get("protocol") as Protocol,
        listenPort: Number(formData.get("listenPort")),
        publicParamsJson,
        isEnabled: formData.get("isEnabled") === "on",
      });

      if (result.ok) {
        toast.success("Protocol config created");
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
          <DialogTitle>New protocol config</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="nodeId">Node</Label>
            <Select name="nodeId" required>
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
          <div className="flex flex-col gap-2">
            <Label htmlFor="protocol">Protocol</Label>
            <Select
              name="protocol"
              value={protocol}
              onValueChange={(value) => {
                const nextProtocol = value as Protocol;
                setProtocol(nextProtocol);
                setListenPort(DEFAULT_PROTOCOL_PORT[nextProtocol]);
              }}
            >
              <SelectTrigger id="protocol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_PROTOCOLS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PROTOCOL_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="listenPort">Listen port</Label>
            <Input
              id="listenPort"
              name="listenPort"
              type="number"
              min={1}
              max={65535}
              value={listenPort}
              onChange={(e) => setListenPort(Number(e.target.value))}
              required
            />
            <p className="text-xs text-muted-foreground">
              Auto-fills to {PROTOCOL_LABELS[protocol]}&apos;s conventional default when you change
              protocol -- edit freely if this node uses a different port.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="publicParamsJson">Public params (JSON)</Label>
            <textarea
              id="publicParamsJson"
              name="publicParamsJson"
              rows={5}
              placeholder='{"realityPublicKey": "...", "shortIds": ["..."], "dest": "example.com:443", "serverName": "example.com"}'
              className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <p className="text-xs text-muted-foreground">
              Generated by the installer when the engine was set up on that node -- WireGuard needs
              serverPublicKey/endpoint/subnetCidr, REALITY needs realityPublicKey/shortIds/dest/serverName.
              Leave empty for OpenVPN (its CA/certs are generated automatically).
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
