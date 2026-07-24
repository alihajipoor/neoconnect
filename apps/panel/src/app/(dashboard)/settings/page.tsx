import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { AdminUser, FreeTrialSettings, Route, SubscriptionPlan } from "@/lib/types";
import { SecurityCard } from "./security-card";
import { FreeTrialSettingsCard } from "./free-trial-settings-card";

export default async function SettingsPage() {
  const [session, me] = await Promise.all([getSession(), apiFetch<AdminUser>("/auth/me")]);

  // Free trial mode is business-level config (it controls who gets a
  // free VPN subscription with no payment info) -- SUPERADMIN-only, same
  // gating as the backend's /free-trial-settings endpoint.
  const isSuperAdmin = session?.role === "SUPERADMIN";
  const [freeTrialSettings, plans, routes] = isSuperAdmin
    ? await Promise.all([
        apiFetch<FreeTrialSettings>("/free-trial-settings"),
        apiFetch<SubscriptionPlan[]>("/plans"),
        apiFetch<Route[]>("/routes"),
      ])
    : [null, [], []];

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account security.</p>
      </div>
      <SecurityCard email={me.email} initialMfaEnabled={me.mfaEnabled} />
      {isSuperAdmin && freeTrialSettings ? (
        <FreeTrialSettingsCard settings={freeTrialSettings} plans={plans} routes={routes} />
      ) : null}
    </div>
  );
}
