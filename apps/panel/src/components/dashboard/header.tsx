import { logoutAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { SessionAdmin } from "@/lib/session";
import { LogOut } from "lucide-react";

const ROLE_BADGE_VARIANT = {
  SUPERADMIN: "highlight",
  SUPPORT: "secondary",
  BILLING: "secondary",
} as const;

export function DashboardHeader({ session }: { session: SessionAdmin }) {
  const initial = session.email.charAt(0).toUpperCase();

  return (
    <header className="flex h-14 items-center justify-end gap-3 border-b border-white/8 bg-card/30 px-4 backdrop-blur-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex size-7 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
          {initial}
        </div>
        <span className="text-sm text-muted-foreground">{session.email}</span>
        <Badge variant={ROLE_BADGE_VARIANT[session.role]}>{session.role}</Badge>
      </div>
      <form action={logoutAction}>
        <Button type="submit" variant="ghost" size="icon" aria-label="Sign out">
          <LogOut className="size-4" />
        </Button>
      </form>
    </header>
  );
}
