"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";

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
  if (result.ok) revalidatePath("/settings");
  return result;
}

export async function updateFreeTrialSettingsAction(input: {
  enabled: boolean;
  trialPlanId?: string;
  trialRouteId?: string;
}): Promise<MutationResult<void>> {
  const result = await apiMutate<void>("/free-trial-settings", {
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
