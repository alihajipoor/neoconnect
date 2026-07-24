import { apiFetch } from "@/lib/api";
import type { AdminUser } from "@/lib/types";
import { SecurityCard } from "./security-card";

export default async function SettingsPage() {
  const me = await apiFetch<AdminUser>("/auth/me");

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account security.</p>
      </div>
      <SecurityCard email={me.email} initialMfaEnabled={me.mfaEnabled} />
    </div>
  );
}
