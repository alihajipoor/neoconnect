import { apiFetch } from "@/lib/api";
import { currentTrustedDeviceId } from "@/lib/trusted-device";
import type { AdminUser } from "@/lib/types";
import { SecurityCard } from "../security-card";
import { type TrustedDevice, TrustedDevicesCard } from "../trusted-devices-card";

export default async function AccountSettingsPage() {
  const me = await apiFetch<AdminUser>("/auth/me");
  const devices = me.mfaEnabled ? await apiFetch<TrustedDevice[]>("/auth/trusted-devices") : [];
  return (
    <div className="flex flex-col gap-6">
      <SecurityCard email={me.email} initialMfaEnabled={me.mfaEnabled} />
      {me.mfaEnabled ? <TrustedDevicesCard devices={devices} currentId={await currentTrustedDeviceId()} /> : null}
    </div>
  );
}
