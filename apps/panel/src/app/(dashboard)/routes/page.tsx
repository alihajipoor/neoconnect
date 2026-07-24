import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { Node, ProtocolConfig, Route } from "@/lib/types";
import { RoutesTable } from "./routes-table";

export default async function RoutesPage() {
  const [routes, protocolConfigs, nodes, session] = await Promise.all([
    apiFetch<Route[]>("/routes"),
    apiFetch<ProtocolConfig[]>("/protocol-configs"),
    apiFetch<Node[]>("/nodes"),
    getSession(),
  ]);
  return (
    <RoutesTable
      routes={routes}
      protocolConfigs={protocolConfigs}
      nodes={nodes}
      canManage={session?.role === "SUPERADMIN"}
    />
  );
}
