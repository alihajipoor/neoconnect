"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { Voucher } from "@/lib/types";

export interface VoucherInput {
  planId: string;
  /** Left out to have the backend generate one. */
  code?: string;
  /** Left out means unlimited redemptions. */
  maxRedemptions?: number | null;
  /** Left out means it never expires. */
  expiresAt?: string | null;
  isActive?: boolean;
  note?: string;
}

export async function createVoucher(input: VoucherInput): Promise<MutationResult<Voucher>> {
  const result = await apiMutate<Voucher>("/vouchers", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/vouchers");
  return result;
}

export async function updateVoucher(
  id: string,
  input: Partial<VoucherInput>,
): Promise<MutationResult<Voucher>> {
  const result = await apiMutate<Voucher>(`/vouchers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/vouchers");
  return result;
}

export async function deleteVoucher(id: string): Promise<MutationResult<{ deleted: boolean }>> {
  const result = await apiMutate<{ deleted: boolean }>(`/vouchers/${id}`, { method: "DELETE" });
  if (result.ok) revalidatePath("/vouchers");
  return result;
}
