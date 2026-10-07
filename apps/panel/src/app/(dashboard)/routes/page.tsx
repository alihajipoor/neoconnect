import { apiFetch } from "@/lib/api";
import { getSession, requireStaff } from "@/lib/session";
import { fetchProtocolConfigs, fetchRoutes } from "@/lib/infra";
import type { Node } from "@/lib/types";
import { RoutesTable } from "./routes-table";

export default async function RoutesPage() {
  await requireStaff();
  const [routes, protocolConfigs, nodes, session] = await Promise.all([
    fetchRoutes(),
    fetchProtocolConfigs(),
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
