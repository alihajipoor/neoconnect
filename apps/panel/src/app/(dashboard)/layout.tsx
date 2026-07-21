import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { DashboardHeader } from "@/components/dashboard/header";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-svh">
      <aside className="w-56 shrink-0 border-r">
        <div className="flex h-14 items-center border-b px-4 text-sm font-semibold">Admin Panel</div>
        <SidebarNav role={session.role} />
      </aside>
      <div className="flex flex-1 flex-col">
        <DashboardHeader session={session} />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
