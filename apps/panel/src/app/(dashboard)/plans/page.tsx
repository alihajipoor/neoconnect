import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { SubscriptionPlan } from "@/lib/types";
import { PlansTable } from "./plans-table";

export default async function PlansPage() {
  const [plans, session] = await Promise.all([apiFetch<SubscriptionPlan[]>("/plans"), getSession()]);
  return <PlansTable plans={plans} canManage={session?.role === "SUPERADMIN"} />;
}
