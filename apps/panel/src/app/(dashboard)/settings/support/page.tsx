import { apiFetch } from "@/lib/api";
import type { SupportSettings } from "@/lib/types";
import { SupportSettingsCard } from "./support-settings-card";

export default async function SupportSettingsPage() {
  const settings = await apiFetch<SupportSettings>("/support/settings");
  return <SupportSettingsCard settings={settings} />;
}
