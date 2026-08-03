import { apiFetch } from "@/lib/api";
import type { EmailSettings } from "@/lib/types";
import { EmailSettingsCard } from "../email-settings-card";

export default async function EmailSettingsPage() {
  const settings = await apiFetch<EmailSettings>("/email-settings");
  return <EmailSettingsCard settings={settings} />;
}
