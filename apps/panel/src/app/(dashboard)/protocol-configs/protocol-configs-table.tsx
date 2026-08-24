"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import type { Node, ProtocolConfig } from "@/lib/types";
import { PROTOCOL_LABELS } from "@/lib/protocol-labels";
import { defaultInboundTag } from "@/lib/inbound-tags";
import { deleteProtocolConfig } from "./actions";
import { ProtocolConfigFormDialog } from "./protocol-config-form-dialog";
import { ProtocolConfigEditDialog } from "./protocol-config-edit-dialog";
import { DeleteConfirm } from "@/components/dashboard/delete-confirm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ProtocolConfigsTable({
  protocolConfigs,
  nodes,
  canManage,
}: {
  protocolConfigs: ProtocolConfig[];
  nodes: Node[];
  canManage: boolean;
}) {
  const nodeName = (nodeId: string) => nodes.find((n) => n.id === nodeId)?.name ?? nodeId;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Protocol Configs</h1>
          <p className="text-sm text-muted-foreground">VPN protocol engines registered on each node.</p>
        </div>
        {canManage && (
          <ProtocolConfigFormDialog
            nodes={nodes}
            trigger={
              <Button size="sm">
                <Plus /> New Protocol Config
              </Button>
            }
          />
        )}
      </div>
      <div className="rounded-lg border border-white/8 bg-card/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Protocol</TableHead>
              <TableHead>Port</TableHead>
              {/* Shown in the list, not only in the edit dialog. Which
                  inbound a config is served on is the field that decides
                  where a relayed customer's traffic leaves the world
                  from, and two rows sharing one is the failure worth
                  spotting at a glance rather than by opening each one. */}
              <TableHead>Inbound</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {protocolConfigs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No protocol configs yet.
                </TableCell>
              </TableRow>
            ) : (
              protocolConfigs.map((pc) => (
                <TableRow key={pc.id}>
                  <TableCell className="font-medium">{nodeName(pc.nodeId)}</TableCell>
                  <TableCell>{PROTOCOL_LABELS[pc.protocol]}</TableCell>
                  <TableCell className="font-mono text-xs">{pc.listenPort}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {(() => {
                      const fallback = defaultInboundTag(pc.protocol, pc.transport);
                      if (pc.inboundTag) return <span>{pc.inboundTag}</span>;
                      // An explicit tag and an inherited one are not the
                      // same fact, and rendering both as plain text
                      // would hide which rows somebody deliberately
                      // routed.
                      return fallback ? (
                        <span className="text-muted-foreground">{fallback}</span>
                      ) : (
                        <span className="text-muted-foreground">--</span>
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    <Badge variant={pc.isEnabled ? "success" : "secondary"}>
                      {pc.isEnabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Row actions">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <ProtocolConfigEditDialog
                            config={pc}
                            trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>Edit</DropdownMenuItem>}
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
                            title="Delete this protocol config?"
                            description="This permanently removes it. Existing routes/protocol users referencing it will block deletion."
                            successMessage="Protocol config deleted"
                            onConfirm={() => deleteProtocolConfig(pc.id)}
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
