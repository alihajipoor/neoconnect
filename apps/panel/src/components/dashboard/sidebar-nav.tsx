"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users, CreditCard, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AdminRole } from "@/lib/session";

const NAV_ITEMS: { href: string; label: string; icon: typeof Users; roles?: AdminRole[] }[] = [
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/plans", label: "Plans", icon: CreditCard },
  { href: "/admins", label: "Admins", icon: ShieldCheck, roles: ["SUPERADMIN"] },
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
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
