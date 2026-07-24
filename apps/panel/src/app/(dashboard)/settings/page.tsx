import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { AdminUser, EmailSettings, FreeTrialSettings, Route, SubscriptionPlan } from "@/lib/types";
import { SecurityCard } from "./security-card";
import { FreeTrialSettingsCard } from "./free-trial-settings-card";
import { EmailSettingsCard } from "./email-settings-card";

export default async function SettingsPage() {
  const [session, me] = await Promise.all([getSession(), apiFetch<AdminUser>("/auth/me")]);

  // Free trial mode and email (SMTP) config are both business-level
  // config -- SUPERADMIN-only, same gating as their respective backend
  // endpoints.
  const isSuperAdmin = session?.role === "SUPERADMIN";
  const [freeTrialSettings, plans, routes, emailSettings] = isSuperAdmin
    ? await Promise.all([
        apiFetch<FreeTrialSettings>("/free-trial-settings"),
        apiFetch<SubscriptionPlan[]>("/plans"),
        apiFetch<Route[]>("/routes"),
        apiFetch<EmailSettings>("/email-settings"),
      ])
    : [null, [], [], null];

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
      {isSuperAdmin && emailSettings ? <EmailSettingsCard settings={emailSettings} /> : null}
    </div>
  );
}
