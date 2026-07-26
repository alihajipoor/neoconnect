"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreditCard, Gift, Mail, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

/** Settings sections.
 *
 * `superAdminOnly` mirrors the backend's own gating rather than being a
 * cosmetic filter -- these endpoints are SUPERADMIN-only, so showing the
 * links to anyone else would just produce a page that fails to load.
 */
const SECTIONS = [
  { href: "/settings/account", label: "Account", icon: ShieldCheck, superAdminOnly: false },
  { href: "/settings/payments", label: "Payments", icon: CreditCard, superAdminOnly: true },
  { href: "/settings/email", label: "Email", icon: Mail, superAdminOnly: true },
  { href: "/settings/trial", label: "Free trial", icon: Gift, superAdminOnly: true },
];

export function SettingsNav({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const pathname = usePathname();
  const sections = SECTIONS.filter((s) => !s.superAdminOnly || isSuperAdmin);

  return (
    <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-48 md:flex-col md:overflow-visible">
      {sections.map((section) => {
        const active = pathname === section.href;
        const Icon = section.icon;
        return (
          <Link
            key={section.href}
            href={section.href}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              active
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
            )}
          >
            <Icon className={cn("size-4", active && "text-primary")} />
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
