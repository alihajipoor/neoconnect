import { Users, CreditCard, ShieldCheck } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { AdminUser, Customer, SubscriptionPlan } from "@/lib/types";
import { StatCard } from "@/components/dashboard/stat-card";

export default async function OverviewPage() {
  const session = await getSession();
  const isSuperAdmin = session?.role === "SUPERADMIN";

  const [customers, plans, admins] = await Promise.all([
    apiFetch<Customer[]>("/customers"),
    apiFetch<SubscriptionPlan[]>("/plans"),
    isSuperAdmin ? apiFetch<AdminUser[]>("/admins") : Promise.resolve(null),
  ]);

  const activePlans = plans.filter((p) => p.isActive).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">What&apos;s happening across NeoConnect right now.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Customers" value={customers.length} icon={Users} accent="primary" />
        <StatCard
          label="Active plans"
          value={`${activePlans} / ${plans.length}`}
          icon={CreditCard}
          accent="highlight"
        />
        {admins !== null && (
          <StatCard label="Admin accounts" value={admins.length} icon={ShieldCheck} accent="success" />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Node and usage metrics will appear here once agent nodes are connected.
      </p>
    </div>
  );
}
