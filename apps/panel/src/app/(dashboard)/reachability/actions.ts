"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";

/** Probe now rather than waiting for the next half-hourly cycle.
 *
 * SUPERADMIN-only on the backend. Not because the result is sensitive --
 * it is the same data the page already shows -- but because it spends
 * requests at a rate-limited third party on behalf of the whole fleet,
 * and a button anyone can hold down is a button that gets the probe
 * provider to start refusing us. */
export async function runReachabilityNow(): Promise<MutationResult<unknown>> {
  const result = await apiMutate<unknown>("/reachability/run", { method: "POST" });
  if (result.ok) revalidatePath("/reachability");
  return result;
}
