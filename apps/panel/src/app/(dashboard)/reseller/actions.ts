"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { ResellerVoucher } from "@/lib/types";

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
