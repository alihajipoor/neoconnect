import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { AdminUser } from "@/lib/types";
import { AdminsTable } from "./admins-table";

export default async function AdminsPage() {
  const session = await getSession();
  if (session?.role !== "SUPERADMIN") redirect("/overview");

  const admins = await apiFetch<AdminUser[]>("/admins");
  return <AdminsTable admins={admins} currentAdminId={session.sub} />;
}
