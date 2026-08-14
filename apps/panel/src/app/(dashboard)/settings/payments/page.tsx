import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { PaymentSettings } from "@/lib/types";
import { PaymentSettingsCard } from "../payment-settings-card";

export default async function PaymentSettingsPage() {
  await requireStaff();
  const settings = await apiFetch<PaymentSettings>("/payment-settings");
  return <PaymentSettingsCard settings={settings} />;
}
