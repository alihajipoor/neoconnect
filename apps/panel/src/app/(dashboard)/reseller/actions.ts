"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { ResellerActivation, ResellerVoucher } from "@/lib/types";

/**
 * Every action revalidates BOTH the balance and the history, because
 * each one changes both: minting spends a token and adds a row,
 * revoking refunds a token and removes one. Revalidating only the list
 * would leave a reseller looking at a balance that is quietly wrong,
 * which for something they paid for is the worst thing to get lazy
 * about.
 */
function revalidate() {
  revalidatePath("/reseller");
}

export async function generateVoucher(
  planId: string,
  recipientEmail?: string,
): Promise<MutationResult<ResellerVoucher & { emailed: boolean }>> {
  const result = await apiMutate<ResellerVoucher & { emailed: boolean }>("/reseller/vouchers", {
    method: "POST",
    body: JSON.stringify({ planId, ...(recipientEmail ? { recipientEmail } : {}) }),
  });
  if (result.ok) revalidate();
  return result;
}

/** Puts a plan straight onto an existing customer's account.
 *
 * Revalidates whether or not it worked, unlike the others. Almost every
 * refusal leaves the balance and the list as they were, but one does
 * not: if the plan went onto the account and a later step failed, the
 * token is spent and the code is in the list as redeemed. The reseller
 * is told so, and the page behind the message has to agree with it. */
export async function activateForCustomer(
  planId: string,
  customerEmail: string,
): Promise<MutationResult<ResellerActivation>> {
  const result = await apiMutate<ResellerActivation>("/reseller/activate", {
    method: "POST",
    body: JSON.stringify({ planId, customerEmail }),
  });
  revalidate();
  return result;
}

export async function resendVoucher(
  id: string,
  email?: string,
): Promise<MutationResult<{ sent: boolean }>> {
  const result = await apiMutate<{ sent: boolean }>(`/reseller/vouchers/${id}/resend`, {
    method: "POST",
    body: JSON.stringify(email ? { email } : {}),
  });
  if (result.ok) revalidate();
  return result;
}

export async function revokeVoucher(
  id: string,
): Promise<MutationResult<{ deleted: boolean; refunded: boolean }>> {
  const result = await apiMutate<{ deleted: boolean; refunded: boolean }>(
    `/reseller/vouchers/${id}`,
    { method: "DELETE" },
  );
  if (result.ok) revalidate();
  return result;
}
