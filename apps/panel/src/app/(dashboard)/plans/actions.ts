"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { Protocol, SubscriptionPlan } from "@/lib/types";

export interface PlanInput {
  name: string;
  dataCapBytes: string;
  durationDays: number;
  priceUsd: number;
  maxConcurrentConnections?: number;
  protocolsAllowed: Protocol[];
  isActive?: boolean;
  defaultRouteId?: string;
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
