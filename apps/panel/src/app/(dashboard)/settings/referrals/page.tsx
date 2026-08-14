import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { ReferralSettings, SubscriptionPlan } from "@/lib/types";
import { ReferralSettingsCard } from "../referral-settings-card";

export default async function ReferralSettingsPage() {
  await requireStaff();
  const [settings, plans] = await Promise.all([
    apiFetch<ReferralSettings>("/referral-settings"),
    apiFetch<SubscriptionPlan[]>("/plans"),
  ]);
  return <ReferralSettingsCard settings={settings} plans={plans} />;
}
