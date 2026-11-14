import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { DashboardHeader } from "@/components/dashboard/header";
import { Logo } from "@/components/brand/logo";

/** The page shell.
 *
 * From lg (1024px) up: the fixed side menu beside the content, as it has
 * always been. Below lg the side menu is not rendered in the flow at all;
 * the header's menu button opens the same list as a drawer (MobileNav),
 * so the content gets the whole width of a phone.
 *
 * Every phone-only rule here is written max-lg: or with env() insets that
 * are zero on a desktop, so the desktop layout does not move. */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-svh bg-background">
      <aside className="w-60 shrink-0 border-r border-white/8 bg-card/40 max-lg:hidden">
        <div className="flex h-14 items-center border-b border-white/8 px-4">
          <Logo />
        </div>
        <SidebarNav role={session.role} />
      </aside>
      {/* min-w-0: a wide table scrolls inside its own box instead of
          stretching the page past the window. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader session={session} />
        <main className="flex-1 p-6 max-sm:pt-5 max-sm:pr-[max(1rem,env(safe-area-inset-right))] max-lg:pb-[max(1.5rem,env(safe-area-inset-bottom))] max-sm:pl-[max(1rem,env(safe-area-inset-left))]">
          {children}
        </main>
      </div>
    </div>
  );
}
