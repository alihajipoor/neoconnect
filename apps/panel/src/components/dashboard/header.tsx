import { logoutAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { SessionAdmin } from "@/lib/session";
import { LogOut } from "lucide-react";

export function DashboardHeader({ session }: { session: SessionAdmin }) {
  return (
    <header className="flex h-14 items-center justify-between border-b px-4">
      <div className="text-sm font-semibold">NeoConnect</div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">{session.email}</span>
        <Badge variant="secondary">{session.role}</Badge>
        <form action={logoutAction}>
          <Button type="submit" variant="ghost" size="icon" aria-label="Sign out">
            <LogOut className="size-4" />
          </Button>
        </form>
      </div>
    </header>
  );
}
