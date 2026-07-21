import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { DashboardHeader } from "@/components/dashboard/header";
import { Logo } from "@/components/brand/logo";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-svh bg-background">
      <aside className="w-60 shrink-0 border-r border-white/8 bg-card/40">
        <div className="flex h-14 items-center border-b border-white/8 px-4">
          <Logo />
        </div>
        <SidebarNav role={session.role} />
      </aside>
      <div className="flex flex-1 flex-col">
        <DashboardHeader session={session} />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
