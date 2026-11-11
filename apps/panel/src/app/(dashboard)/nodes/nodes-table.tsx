"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import type { Node, NodeStatus } from "@/lib/types";
import { isRetiredNode } from "@/lib/retired";
import { deleteNode } from "./actions";
import { NodeFormDialog } from "./node-form-dialog";
import { EnrollmentTokenDialog } from "./enrollment-token-dialog";
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

const STATUS_VARIANT: Record<NodeStatus, "success" | "destructive" | "outline" | "secondary"> = {
  ONLINE: "success",
  OFFLINE: "destructive",
  PENDING: "outline",
  DISABLED: "secondary",
};

export function NodesTable({ nodes, canManage }: { nodes: Node[]; canManage: boolean }) {
  // Retired servers (DISABLED) stay in the database -- deleting one wipes
  // its usage history -- so they are kept, below the live fleet and
  // folded away.
  const live = nodes.filter((n) => !isRetiredNode(n));
  const retired = nodes.filter(isRetiredNode);
  const [showRetired, setShowRetired] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Nodes</h1>
          <p className="text-sm text-muted-foreground">VPS boxes running the agent and VPN protocol engines.</p>
        </div>
        {canManage && (
          <NodeFormDialog
            trigger={
              <Button size="sm">
                <Plus /> New Node
              </Button>
            }
          />
        )}
      </div>
      <NodeRows nodes={live} canManage={canManage} empty="No nodes yet." />
      {retired.length > 0 ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowRetired((v) => !v)}
            aria-expanded={showRetired}
            className="flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {showRetired ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Retired ({retired.length})
          </button>
          {showRetired ? <NodeRows nodes={retired} canManage={canManage} empty="" /> : null}
        </div>
      ) : null}
    </div>
  );
}

function NodeRows({ nodes, canManage, empty }: { nodes: Node[]; canManage: boolean; empty: string }) {
  return (
    <div className="rounded-lg border border-white/8 bg-card/40">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Region</TableHead>
            <TableHead>Public IP</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last heartbeat</TableHead>
            {canManage && <TableHead className="w-10" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            nodes.map((node) => (
              <TableRow key={node.id}>
                <TableCell className="font-medium">{node.name}</TableCell>
                <TableCell>
                  <Badge variant="outline">{node.role}</Badge>
                </TableCell>
                <TableCell>{node.region}</TableCell>
                <TableCell className="font-mono text-xs">{node.publicIp}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[node.status]}>{node.status}</Badge>
                </TableCell>
                <TableCell>
                  {node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).toLocaleString() : "—"}
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
                        <EnrollmentTokenDialog
                          nodeId={node.id}
                          nodeName={node.name}
                          trigger={
                            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                              Enrollment token
                            </DropdownMenuItem>
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
                          title="Delete this node?"
                          description={`This permanently removes "${node.name}". Existing protocol configs on this node will block deletion.`}
                          successMessage="Node deleted"
                          onConfirm={() => deleteNode(node.id)}
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
  );
}
