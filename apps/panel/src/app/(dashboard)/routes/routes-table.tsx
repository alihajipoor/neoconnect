"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import type { Node, ProtocolConfig, Route } from "@/lib/types";
import { PROTOCOL_LABELS } from "@/lib/protocol-labels";
import { deleteRoute } from "./actions";
import { RouteFormDialog } from "./route-form-dialog";
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

export function RoutesTable({
  routes,
  protocolConfigs,
  nodes,
  canManage,
}: {
  routes: Route[];
  protocolConfigs: ProtocolConfig[];
  nodes: Node[];
  canManage: boolean;
}) {
  const describe = (protocolConfigId: string | null) => {
    if (!protocolConfigId) return "—";
    const pc = protocolConfigs.find((p) => p.id === protocolConfigId);
    if (!pc) return protocolConfigId;
    const node = nodes.find((n) => n.id === pc.nodeId);
    return `${node?.name ?? pc.nodeId} — ${PROTOCOL_LABELS[pc.protocol]}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Routes</h1>
          <p className="text-sm text-muted-foreground">
            The &ldquo;servers&rdquo; customers connect through -- a direct entry, or a relay chained to an
            exit.
          </p>
        </div>
        {canManage && (
          <RouteFormDialog
            protocolConfigs={protocolConfigs}
            nodes={nodes}
            trigger={
              <Button size="sm">
                <Plus /> New Route
              </Button>
            }
          />
        )}
      </div>
      <div className="rounded-lg border border-white/8 bg-card/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead>Exit</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {routes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No routes yet.
                </TableCell>
              </TableRow>
            ) : (
              routes.map((route) => (
                <TableRow key={route.id}>
                  <TableCell className="font-medium">{route.name}</TableCell>
                  <TableCell>{describe(route.entryProtocolConfigId)}</TableCell>
                  <TableCell>{describe(route.exitProtocolConfigId)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{route.exitProtocolConfigId ? "Relayed" : "Direct"}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={route.isEnabled ? "success" : "secondary"}>
                      {route.isEnabled ? "Enabled" : "Disabled"}
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
                          <DeleteConfirm
                            trigger={
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={(e) => e.preventDefault()}
                              >
                                Delete
                              </DropdownMenuItem>
                            }
                            title="Delete this route?"
                            description={`This permanently removes ${route.name}. Existing protocol users on it will block deletion.`}
                            successMessage="Route deleted"
                            onConfirm={() => deleteRoute(route.id)}
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
