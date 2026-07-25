"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { Invoice } from "@/lib/types";

/** The only status change an admin can make by hand. The backend refuses
 * to void a PAID invoice -- that's a refund, not a void -- so a rejected
 * attempt comes back as an inline error rather than being hidden here. */
export async function voidInvoice(id: string): Promise<MutationResult<Invoice>> {
  const result = await apiMutate<Invoice>(`/invoices/${id}/void`, { method: "PATCH" });
  if (result.ok) revalidatePath("/invoices");
  return result;
}
