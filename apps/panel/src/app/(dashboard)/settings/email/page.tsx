import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { EmailSettings } from "@/lib/types";
import { EmailSettingsCard } from "../email-settings-card";

export default async function EmailSettingsPage() {
  await requireStaff();
  const settings = await apiFetch<EmailSettings>("/email-settings");
  return <EmailSettingsCard settings={settings} />;
}
