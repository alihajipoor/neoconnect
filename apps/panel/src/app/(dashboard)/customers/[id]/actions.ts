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
