import { apiFetch } from "@/lib/api";
import type { AdminUser } from "@/lib/types";
import { SecurityCard } from "../security-card";

export default async function AccountSettingsPage() {
  const me = await apiFetch<AdminUser>("/auth/me");
  return <SecurityCard email={me.email} initialMfaEnabled={me.mfaEnabled} />;
}
