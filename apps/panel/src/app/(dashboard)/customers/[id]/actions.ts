"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { Subscription, SubscriptionStatus } from "@/lib/types";

/** Every action here revalidates the customer page it was invoked from,
 * because all of them change something that page is showing. */
function done<T>(customerId: string, result: MutationResult<T>): MutationResult<T> {
  if (result.ok) revalidatePath(`/customers/${customerId}`);
  return result;
}

export async function setSubscriptionStatus(
  customerId: string,
  id: string,
  status: SubscriptionStatus,
): Promise<MutationResult<Subscription>> {
  return done(
    customerId,
    await apiMutate<Subscription>(`/subscriptions/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  );
}

export async function extendSubscription(
  customerId: string,
  id: string,
  days: number,
): Promise<MutationResult<Subscription>> {
  return done(
    customerId,
    await apiMutate<Subscription>(`/subscriptions/${id}/extend`, {
      method: "POST",
      body: JSON.stringify({ days }),
    }),
  );
}

export async function resetSubscriptionUsage(
  customerId: string,
  id: string,
): Promise<MutationResult<Subscription>> {
  return done(
    customerId,
    await apiMutate<Subscription>(`/subscriptions/${id}/reset-usage`, { method: "POST" }),
  );
}

/** `null` is unlimited, sent as an explicit null: the backend reads an
 * absent field as a mistake, not as "no limit". */
export async function setSubscriptionDataCap(
  customerId: string,
  id: string,
  dataCapBytes: string | null,
): Promise<MutationResult<Subscription>> {
  return done(
    customerId,
    await apiMutate<Subscription>(`/subscriptions/${id}/data-cap`, {
      method: "PATCH",
      body: JSON.stringify({ dataCapBytes }),
    }),
  );
}

/** Marks the customer's email verified on their behalf, with everything a
 * real verification brings (the trial if trial mode is on, the referral
 * notice). */
export async function markCustomerEmailVerified(
  customerId: string,
): Promise<MutationResult<{ alreadyVerified: boolean }>> {
  return done(
    customerId,
    await apiMutate<{ alreadyVerified: boolean }>(`/customers/${customerId}/verify-email`, { method: "POST" }),
  );
}

export async function deleteSubscription(
  customerId: string,
  id: string,
): Promise<MutationResult<{ deleted: boolean }>> {
  return done(
    customerId,
    await apiMutate<{ deleted: boolean }>(`/subscriptions/${id}`, { method: "DELETE" }),
  );
}

/** Gives the customer a plan and provisions it.
 *
 * Deliberately the /assign endpoint rather than a plain create: that
 * one only writes the row, leaving a subscription the customer cannot
 * actually connect with. */
export async function assignPlan(
  customerId: string,
  planId: string,
): Promise<MutationResult<Subscription>> {
  return done(
    customerId,
    await apiMutate<Subscription>("/subscriptions/assign", {
      method: "POST",
      body: JSON.stringify({ customerId, planId }),
    }),
  );
}

export async function changeSubscriptionPlan(
  customerId: string,
  id: string,
  planId: string,
): Promise<MutationResult<Subscription>> {
  return done(
    customerId,
    await apiMutate<Subscription>(`/subscriptions/${id}/plan`, {
      method: "PATCH",
      body: JSON.stringify({ planId }),
    }),
  );
}

/** Support moving an account to a new address on its recovery code alone
 * (docs/relay-last-resort.md, R3.9). Returns the account's new recovery
 * code, to be handed to the customer: the old one has been read out. */
export async function moveAddressWithRecoveryCode(
  customerId: string,
  recoveryCode: string,
  email: string,
): Promise<MutationResult<{ email: string; recoveryCode: string }>> {
  return done(
    customerId,
    await apiMutate<{ email: string; recoveryCode: string }>(`/relay-auth/customers/${customerId}/move-address`, {
      method: "POST",
      body: JSON.stringify({ recoveryCode, email }),
    }),
  );
}

/** Signs one of the customer's devices out: its session is revoked and
 * the VPN credentials that belonged to it are removed, which also gives
 * up whatever device slot it held. The customer can sign in on it again;
 * this is not a block. */
export async function signOutDevice(
  customerId: string,
  sessionId: string,
): Promise<MutationResult<{ ok: true }>> {
  return done(
    customerId,
    await apiMutate<{ ok: true }>(
      `/customers/${encodeURIComponent(customerId)}/sessions/${encodeURIComponent(sessionId)}/sign-out`,
      { method: "POST" },
    ),
  );
}
