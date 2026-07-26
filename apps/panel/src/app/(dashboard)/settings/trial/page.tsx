import { apiFetch } from "@/lib/api";
import type { FreeTrialSettings, Route, SubscriptionPlan } from "@/lib/types";
import { FreeTrialSettingsCard } from "../free-trial-settings-card";

export default async function TrialSettingsPage() {
  const [settings, plans, routes] = await Promise.all([
    apiFetch<FreeTrialSettings>("/free-trial-settings"),
    apiFetch<SubscriptionPlan[]>("/plans"),
    apiFetch<Route[]>("/routes"),
  ]);
  return <FreeTrialSettingsCard settings={settings} plans={plans} routes={routes} />;
}
