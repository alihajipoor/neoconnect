"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { SupportTicket, SupportTicketStatus } from "@/lib/types";

export async function replyToTicket(
  id: string,
  body: string,
): Promise<MutationResult<SupportTicket>> {
  const result = await apiMutate<SupportTicket>(`/support/tickets/${id}/reply`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  // Both the thread and the rail beside it change -- the reply appears
  // in one and the status badge flips in the other.
  if (result.ok) revalidatePath("/support", "layout");
  return result;
}

export async function setTicketStatus(
  id: string,
  status: SupportTicketStatus,
): Promise<MutationResult<SupportTicket>> {
  const result = await apiMutate<SupportTicket>(`/support/tickets/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  if (result.ok) revalidatePath("/support", "layout");
  return result;
}
