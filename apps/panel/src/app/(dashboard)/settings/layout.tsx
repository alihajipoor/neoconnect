import { getSession } from "@/lib/session";
import { SettingsNav } from "./settings-nav";

/** Settings is a section, not a page.
 *
 * It previously stacked every card in one scrolling column, so finding the
 * SMTP form meant scrolling past MFA and free-trial config. Each concern
 * now has its own route, and the nav below is the only thing shared.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Your account, and how this panel runs.</p>
      </div>
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <SettingsNav isSuperAdmin={session?.role === "SUPERADMIN"} />
        <div className="min-w-0 max-w-2xl flex-1">{children}</div>
      </div>
    </div>
  );
}
