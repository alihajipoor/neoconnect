"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";

/**
 * Sets a reseller's remaining tokens for one plan to an absolute
 * number, deliberately not a delta.
 *
 * The operator types this in after being paid, and a form that
 * double-submits must not grant twice. "Set to 10" is idempotent;
 * "add 10" is not, and the cost of getting that wrong is subscriptions
 * given away for free.
 */
export async function setResellerBalance(
  resellerId: string,
  planId: string,
  balance: number,
): Promise<MutationResult<unknown>> {
  const result = await apiMutate(`/resellers/${resellerId}/balance`, {
    method: "POST",
    body: JSON.stringify({ planId, balance }),
  });
  if (result.ok) revalidatePath("/resellers");
  return result;
}
