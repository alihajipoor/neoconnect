"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { Protocol, SubscriptionPlan } from "@/lib/types";

export interface PlanInput {
  name: string;
  /** Null means unlimited traffic. */
  dataCapBytes: string | null;
  durationDays: number;
  priceUsd: number;
  maxConcurrentConnections?: number;
  /** Per-user speed caps in Mbit/s. Omitted means uncapped -- never 0,
   * which the node reads as a limit of zero and cuts the customer off. */
  maxDownloadMbps?: number;
  maxUploadMbps?: number;
  protocolsAllowed: Protocol[];
  isActive?: boolean;
  defaultRouteId?: string;
  /** Which routes this plan may be served by.
   *
   * An empty array is meaningful and is sent deliberately: it clears any
   * restriction back to "every route this plan's protocols and relay
   * policy allow". Omitting the field leaves the current selection
   * alone, so the form always sends it. */
  allowedRouteIds?: string[];
}

export async function createPlan(input: PlanInput): Promise<MutationResult<SubscriptionPlan>> {
  const result = await apiMutate<SubscriptionPlan>("/plans", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/plans");
  return result;
}

export async function updatePlan(
  id: string,
  input: Partial<PlanInput>,
): Promise<MutationResult<SubscriptionPlan>> {
  const result = await apiMutate<SubscriptionPlan>(`/plans/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/plans");
  return result;
}

export async function deletePlan(id: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>(`/plans/${id}`, { method: "DELETE" });
  if (result.ok) revalidatePath("/plans");
  return result;
}
