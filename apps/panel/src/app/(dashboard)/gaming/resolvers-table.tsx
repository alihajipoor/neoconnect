"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import type { GamingResolver, Node } from "@/lib/types";
import { deleteGamingResolver } from "./actions";
import { ResolverFormDialog } from "./resolver-form-dialog";
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

export function ResolversTable({
  resolvers,
  nodes,
  canManage,
}: {
  resolvers: GamingResolver[];
  nodes: Node[];
  canManage: boolean;
}) {
  const nodeName = (resolver: GamingResolver) =>
    resolver.node?.name ?? nodes.find((n) => n.id === resolver.nodeId)?.name ?? resolver.nodeId;
  const nodeRegion = (resolver: GamingResolver) =>
    resolver.node?.region ?? nodes.find((n) => n.id === resolver.nodeId)?.region ?? null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Resolvers</h2>
          {/* The one sentence that has to be here. Thirteen relay routes
              once reported ONLINE while every one of them was dead, and
              an operator reading a green "Enabled" column would make the
              same mistake again. */}
          <p className="max-w-3xl text-sm text-muted-foreground">
            A resolver answers gaming hostnames with the node&apos;s proxy address and answers
            everything else truthfully.{" "}
            <span className="text-foreground">
              A resolver that has never confirmed is never handed to a client
            </span>{" "}
            -- enabling one is a request, not a state. Health below is what the control plane has
            actually seen, not what was configured.
          </p>
        </div>
        {canManage && (
          <ResolverFormDialog
            nodes={nodes}
            trigger={
              <Button size="sm">
                <Plus /> New Resolver
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
              <TableHead>DoH endpoint</TableHead>
              <TableHead>Proxy</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Health</TableHead>
              {canManage && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {resolvers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canManage ? 6 : 5} className="py-8 text-center text-muted-foreground">
                  No resolvers yet. Without one, gaming mode has nowhere to send a query and no client
                  can use it.
                </TableCell>
              </TableRow>
            ) : (
              resolvers.map((resolver) => (
                <TableRow key={resolver.id}>
                  <TableCell>
                    <div className="font-medium">{nodeName(resolver)}</div>
                    {nodeRegion(resolver) && (
                      <div className="text-xs text-muted-foreground">{nodeRegion(resolver)}</div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {resolver.dohHost}:{resolver.dohPort}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {resolver.proxyIp}:{resolver.proxyPort}
                  </TableCell>
                  <TableCell>
                    <Badge variant={resolver.isEnabled ? "outline" : "secondary"}>
                      {resolver.isEnabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {/* Never a dash and never an empty cell. "Nothing has
                        ever confirmed this works" is a finding, and a
                        blank column reads as "fine, no news". */}
                    <div className="flex flex-col gap-1">
                      {resolver.confirmedAt === null ? (
                        <Badge variant="outline" className="border-amber-500/40 text-amber-300">
                          never confirmed
                        </Badge>
                      ) : (
                        <Badge variant="success">
                          confirmed {new Date(resolver.confirmedAt).toLocaleString()}
                        </Badge>
                      )}
                      {resolver.lastError && (
                        <span
                          className="max-w-64 truncate text-xs text-destructive"
                          title={resolver.lastError}
                        >
                          {resolver.lastError}
                        </span>
                      )}
                    </div>
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
                          <ResolverFormDialog
                            resolver={resolver}
                            nodes={nodes}
                            trigger={
                              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                                Edit
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
                            title="Delete this resolver?"
                            description={`Customers whose clients are pointed at ${resolver.dohHost} lose gaming mode until they fetch a new one.`}
                            successMessage="Resolver deleted"
                            onConfirm={() => deleteGamingResolver(resolver.id)}
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
    </section>
  );
}
