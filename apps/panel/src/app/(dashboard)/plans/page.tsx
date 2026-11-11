import { apiFetch } from "@/lib/api";
import { getSession, requireStaff } from "@/lib/session";
import { fetchProtocolConfigs, fetchRoutes } from "@/lib/infra";
import type { Node, SubscriptionPlan } from "@/lib/types";
import { PlansTable } from "./plans-table";

export default async function PlansPage() {
  await requireStaff();
  // Configs and nodes only to tell which server each route is on, so the
  // editor can group the routes and put retired servers out of the way.
  const [plans, routes, protocolConfigs, nodes, session] = await Promise.all([
    apiFetch<SubscriptionPlan[]>("/plans"),
    fetchRoutes(),
    fetchProtocolConfigs(),
    apiFetch<Node[]>("/nodes"),
    getSession(),
  ]);
  return (
    <PlansTable
      plans={plans}
      routes={routes}
      protocolConfigs={protocolConfigs}
      nodes={nodes}
      canManage={session?.role === "SUPERADMIN"}
    />
  );
}
