"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { SupportSettings } from "@/lib/types";

export interface SupportSettingsInput {
  acceptingTickets: boolean;
  awayMessage?: string;
  replyWithinHours?: number;
}

export async function updateSupportSettings(
  input: SupportSettingsInput,
): Promise<MutationResult<SupportSettings>> {
  const result = await apiMutate<SupportSettings>("/support/settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) {
    revalidatePath("/settings/support");
    // The inbox header states whether support is open, so it goes
    // stale the moment this changes.
    revalidatePath("/support", "layout");
  }
  return result;
}
