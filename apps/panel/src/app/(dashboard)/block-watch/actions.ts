"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";

export type BlockAction = "replaced" | "retired" | "keep" | "snooze";

/** The owner's answer to an incident. SUPERADMIN-only on the backend. It
 * is recorded and nothing else: no server is touched by it. */
export async function answerIncident(
  id: string,
  action: BlockAction,
  opts: { hours?: number; note?: string } = {},
): Promise<MutationResult<unknown>> {
  const result = await apiMutate<unknown>(`/block-watch/incidents/${encodeURIComponent(id)}/action`, {
    method: "POST",
    body: JSON.stringify({ action, ...opts }),
  });
  if (result.ok) revalidatePath("/block-watch");
  return result;
}

/** Evaluate now rather than at the next half-hourly sweep. */
export async function runBlockWatchNow(): Promise<MutationResult<unknown>> {
  const result = await apiMutate<unknown>("/block-watch/run", { method: "POST" });
  if (result.ok) revalidatePath("/block-watch");
  return result;
}
