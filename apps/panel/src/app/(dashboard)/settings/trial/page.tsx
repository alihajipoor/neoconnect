import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { FreeTrialSettings, SubscriptionPlan } from "@/lib/types";
import { FreeTrialSettingsCard } from "../free-trial-settings-card";

export default async function TrialSettingsPage() {
  await requireStaff();
  const [settings, plans] = await Promise.all([
    apiFetch<FreeTrialSettings>("/free-trial-settings"),
    apiFetch<SubscriptionPlan[]>("/plans"),
  ]);
  return <FreeTrialSettingsCard settings={settings} plans={plans} />;
}
