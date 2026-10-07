import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import { fetchProtocolConfigs, fetchRoutes } from "@/lib/infra";
import type { FreeTrialSettings, Node } from "@/lib/types";
import { RoutesTable } from "./routes-table";

export default async function RoutesPage() {
  const session = await requireStaff();
  const canManage = session.role === "SUPERADMIN";
  const [routes, protocolConfigs, nodes, trial] = await Promise.all([
    fetchRoutes(),
    fetchProtocolConfigs(),
    apiFetch<Node[]>("/nodes"),
    // Only the delete dialog uses it, and only SUPERADMIN may delete -- or
    // read these settings.
    canManage ? apiFetch<FreeTrialSettings>("/free-trial-settings") : Promise.resolve(null),
  ]);
  return (
    <RoutesTable
      routes={routes}
      protocolConfigs={protocolConfigs}
      nodes={nodes}
      canManage={canManage}
      trialRouteId={trial?.trialRouteId ?? null}
    />
  );
}
