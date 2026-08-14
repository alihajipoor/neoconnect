import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { FreeTrialSettings, Route, SubscriptionPlan } from "@/lib/types";
import { FreeTrialSettingsCard } from "../free-trial-settings-card";

export default async function TrialSettingsPage() {
  await requireStaff();
  const [settings, plans, routes] = await Promise.all([
    apiFetch<FreeTrialSettings>("/free-trial-settings"),
    apiFetch<SubscriptionPlan[]>("/plans"),
    apiFetch<Route[]>("/routes"),
  ]);
  return <FreeTrialSettingsCard settings={settings} plans={plans} routes={routes} />;
}
