import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import { fetchProtocolConfigs, fetchRoutes } from "@/lib/infra";
import type { Node } from "@/lib/types";
import { RoutesTable } from "./routes-table";

export default async function RoutesPage() {
  const session = await requireStaff();
  const canManage = session.role === "SUPERADMIN";
  const [routes, protocolConfigs, nodes] = await Promise.all([
    fetchRoutes(),
    fetchProtocolConfigs(),
    apiFetch<Node[]>("/nodes"),
  ]);
  return (
    <RoutesTable
      routes={routes}
      protocolConfigs={protocolConfigs}
      nodes={nodes}
      canManage={canManage}
    />
  );
}
