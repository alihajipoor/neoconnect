"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, CreditCard, ShieldCheck, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AdminRole } from "@/lib/session";

const NAV_ITEMS: { href: string; label: string; icon: typeof Users; roles?: AdminRole[] }[] = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/plans", label: "Plans", icon: CreditCard },
  { href: "/admins", label: "Admins", icon: ShieldCheck, roles: ["SUPERADMIN"] },
  // No `roles` restriction -- every admin manages their own account
  // security regardless of role, unlike /admins (managing OTHER admins).
  { href: "/settings", label: "Settings", icon: Settings },
];

export function SidebarNav({ role }: { role: AdminRole }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(role));

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
