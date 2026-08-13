import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { ResellerSummary, SubscriptionPlan } from "@/lib/types";
import { ResellersTable } from "./resellers-table";

/**
 * SUPERADMIN only, matching the backend. Granting capacity is granting
 * money's worth -- a balance is subscriptions somebody can hand out for
 * free -- so it belongs with the role that manages admins rather than
 * with SUPPORT or BILLING.
 */
export default async function ResellersPage() {
  const session = await getSession();
  if (session?.role !== "SUPERADMIN") redirect("/overview");

  const [resellers, plans] = await Promise.all([
    apiFetch<ResellerSummary[]>("/resellers"),
    apiFetch<SubscriptionPlan[]>("/plans"),
  ]);

  return <ResellersTable resellers={resellers} plans={plans} />;
}
