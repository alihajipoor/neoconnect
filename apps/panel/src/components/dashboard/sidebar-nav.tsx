"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, CreditCard, ShieldCheck, Settings, Server, Radio, Route as RouteIcon, Megaphone, ReceiptText, Ticket, LifeBuoy, Activity, Handshake } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AdminRole } from "@/lib/session";

const NAV_ITEMS: { href: string; label: string; icon: typeof Users; roles?: AdminRole[] }[] = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/plans", label: "Plans", icon: CreditCard },
  // Viewable by every role (GET is open to any admin on the backend);
  // create/delete are SUPERADMIN-only, gated per-page via `canManage`,
  // same pattern as Plans -- not a nav-level restriction.
  { href: "/nodes", label: "Nodes", icon: Server },
  { href: "/protocol-configs", label: "Protocol Configs", icon: Radio },
  { href: "/routes", label: "Routes", icon: RouteIcon },
  { href: "/invoices", label: "Invoices", icon: ReceiptText, roles: ["SUPERADMIN", "BILLING"] },
  // Same gating as Invoices: a voucher gives a paid plan away, which is
  // a commercial act rather than routine support work.
  { href: "/vouchers", label: "Vouchers", icon: Ticket, roles: ["SUPERADMIN", "BILLING"] },
  { href: "/support", label: "Support", icon: LifeBuoy, roles: ["SUPERADMIN", "SUPPORT"] },
  // No role restriction: diagnosing why a customer cannot connect is
  // support work, and the backend gates the read the same way.
  { href: "/client-attempts", label: "Client Attempts", icon: Activity },
  { href: "/announcements", label: "Announcements", icon: Megaphone, roles: ["SUPERADMIN"] },
  { href: "/admins", label: "Admins", icon: ShieldCheck, roles: ["SUPERADMIN"] },
  // The reseller's own section: their balances, their codes. Also shown
  // to SUPERADMIN so the operator can see what a reseller sees while
  // helping one.
  { href: "/reseller", label: "My Codes", icon: Ticket, roles: ["RESELLER", "SUPERADMIN"] },
  // The operator's view of every reseller and their capacity. Granting
  // capacity is giving away subscriptions, so it sits with the role that
  // manages admins.
  { href: "/resellers", label: "Resellers", icon: Handshake, roles: ["SUPERADMIN"] },
  // No `roles` restriction -- every admin manages their own account
  // security regardless of role, unlike /admins (managing OTHER admins).
  { href: "/settings", label: "Settings", icon: Settings },
];

/**
 * RESELLER is an allowlist, not a filter.
 *
 * Every other role sees anything without a `roles` restriction, which
 * was safe while all three were staff. A reseller is an outsider with a
 * panel login, so that default is exactly wrong for them: adding the
 * role would silently have handed them Customers, Nodes, Protocol
 * Configs, Routes and Client Attempts, because none of those carries a
 * restriction.
 *
 * Listing what they MAY see means the next page someone adds is hidden
 * from resellers until it is deliberately allowed, rather than exposed
 * until someone notices. The backend gates each endpoint too -- this is
 * the navigation, not the security boundary -- but a menu full of pages
 * that 403 is its own kind of broken.
 */
const RESELLER_ALLOWED = new Set(["/reseller", "/settings"]);

export function SidebarNav({ role }: { role: AdminRole }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((item) =>
    role === "RESELLER"
      ? RESELLER_ALLOWED.has(item.href)
      : !item.roles || item.roles.includes(role),
  );

  return (
    <nav className="flex flex-col gap-1 p-3">
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
            )}
          >
            {active && (
              <span className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary" />
            )}
            <Icon className={cn("size-4", active && "text-primary")} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
