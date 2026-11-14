"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import { clearTrustedDevice, currentTrustedDeviceId } from "@/lib/trusted-device";

export interface MfaSetupResult {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

export async function setupMfaAction(): Promise<MutationResult<MfaSetupResult>> {
  return apiMutate<MfaSetupResult>("/auth/mfa/setup", { method: "POST" });
}

export async function enableMfaAction(code: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>("/auth/mfa/enable", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  if (result.ok) revalidatePath("/settings");
  return result;
}

export async function disableMfaAction(password: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>("/auth/mfa/disable", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  if (result.ok) {
    // The backend has dropped every trusted device of the account.
    await clearTrustedDevice();
    revalidatePath("/settings");
  }
  return result;
}

/** Removes one of the caller's trusted devices; this browser's own cookies
 * go too when it is this one. */
export async function removeTrustedDeviceAction(id: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>(`/auth/trusted-devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (result.ok) {
    if ((await currentTrustedDeviceId()) === id) await clearTrustedDevice();
    revalidatePath("/settings/account");
  }
  return result;
}

export async function removeAllTrustedDevicesAction(): Promise<MutationResult<void>> {
  const result = await apiMutate<void>("/auth/trusted-devices", { method: "DELETE" });
  if (result.ok) {
    await clearTrustedDevice();
    revalidatePath("/settings/account");
  }
  return result;
}

export async function updateFreeTrialSettingsAction(input: {
  enabled: boolean;
  trialPlanId?: string;
}): Promise<MutationResult<void>> {
  const result = await apiMutate<void>("/free-trial-settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/settings");
  return result;
}

export async function updateReferralSettingsAction(input: {
  enabled: boolean;
  rewardPlanId?: string;
  loyalFriendMonths: number;
  friendsRequired: number;
  friendMonths: number;
  rewardDays: number;
}): Promise<MutationResult<void>> {
  const result = await apiMutate<void>("/referral-settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/settings");
  return result;
}

export async function updateEmailSettingsAction(input: {
  enabled: boolean;
  secure: boolean;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  fromAddress?: string;
}): Promise<MutationResult<void>> {
  const result = await apiMutate<void>("/email-settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/settings");
  return result;
}

export async function updatePaymentSettingsAction(input: {
  stripeEnabled: boolean;
  stripePublishableKey?: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  nowPaymentsEnabled: boolean;
  nowPaymentsApiKey?: string;
  nowPaymentsIpnSecret?: string;
  plisioEnabled: boolean;
  /** Plisio has no separate IPN secret: it signs callbacks with this key. */
  plisioApiKey?: string;
}): Promise<MutationResult<void>> {
  const result = await apiMutate<void>("/payment-settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  // Every settings section lives under /settings, so the whole subtree is
  // revalidated rather than just the page that submitted.
  if (result.ok) revalidatePath("/settings", "layout");
  return result;
}

export async function updateRelayAuthAction(input: {
  mode?: "OFF" | "AUTO" | "INTRANET";
  hostingAsns?: number[];
}): Promise<MutationResult<void>> {
  const result = await apiMutate<void>("/relay-auth", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/settings/relay");
  return result;
}
