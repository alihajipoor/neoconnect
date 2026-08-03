import { apiFetch } from "@/lib/api";
import type { PaymentSettings } from "@/lib/types";
import { PaymentSettingsCard } from "../payment-settings-card";

export default async function PaymentSettingsPage() {
  const settings = await apiFetch<PaymentSettings>("/payment-settings");
  return <PaymentSettingsCard settings={settings} />;
}
