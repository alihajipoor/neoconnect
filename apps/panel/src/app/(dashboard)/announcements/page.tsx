import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import { fetchProtocolConfigs, fetchRoutes } from "@/lib/infra";
import type { Node, SubscriptionPlan } from "@/lib/types";
import { AnnouncementForm } from "./announcement-form";

// SUPERADMIN-only, same gating as the backend's POST /announcements/send
// -- broadcasting to the whole customer base is business-sensitive, not
// routine admin/support work.
export default async function AnnouncementsPage() {
  const session = await getSession();
  if (session?.role !== "SUPERADMIN") redirect("/overview");

  const [plans, routes, protocolConfigs, nodes] = await Promise.all([
    apiFetch<SubscriptionPlan[]>("/plans"),
    fetchRoutes(),
    fetchProtocolConfigs(),
    apiFetch<Node[]>("/nodes"),
  ]);

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Announcements</h1>
        <p className="text-sm text-muted-foreground">
          Send an email to customers matching the filters below. Filters combine (AND) -- leave all of them
          empty to reach every subscriber, regardless of status.
        </p>
      </div>
      <AnnouncementForm plans={plans} routes={routes} protocolConfigs={protocolConfigs} nodes={nodes} />
    </div>
  );
}
