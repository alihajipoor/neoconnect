import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { RelayAuthStatus } from "@/lib/types";
import { RelaySettingsCard } from "../relay-settings-card";

export default async function RelaySettingsPage() {
  await requireStaff();
  const status = await apiFetch<RelayAuthStatus>("/relay-auth");
  return <RelaySettingsCard status={status} />;
}
