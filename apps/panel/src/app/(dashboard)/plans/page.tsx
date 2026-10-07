import { apiFetch } from "@/lib/api";
import { getSession, requireStaff } from "@/lib/session";
import { fetchRoutes } from "@/lib/infra";
import type { SubscriptionPlan } from "@/lib/types";
import { PlansTable } from "./plans-table";

export default async function PlansPage() {
  await requireStaff();
  const [plans, routes, session] = await Promise.all([
    apiFetch<SubscriptionPlan[]>("/plans"),
    fetchRoutes(),
    getSession(),
  ]);
  return <PlansTable plans={plans} routes={routes} canManage={session?.role === "SUPERADMIN"} />;
}
