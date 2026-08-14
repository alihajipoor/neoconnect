import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { SupportSettings } from "@/lib/types";
import { SupportSettingsCard } from "./support-settings-card";

export default async function SupportSettingsPage() {
  await requireStaff();
  const settings = await apiFetch<SupportSettings>("/support/settings");
  return <SupportSettingsCard settings={settings} />;
}
