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
