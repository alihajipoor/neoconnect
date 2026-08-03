"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { AppLinks } from "@/lib/types";

export async function updateAppLinks(input: AppLinks): Promise<MutationResult<AppLinks>> {
  // Send the four link fields and nothing else. GET /app-links returns
  // the whole row -- id, updatedAt -- and the card round-trips what it
  // was given, so posting `input` wholesale sent those back too and the
  // backend's whitelisting DTO rejected them ("property id should not
  // exist"). Picking the fields here fixes it for every caller rather
  // than relying on each form to strip them.
  const result = await apiMutate<AppLinks>("/app-links", {
    method: "PATCH",
    body: JSON.stringify({
      websiteUrl: input.websiteUrl ?? "",
      discordUrl: input.discordUrl ?? "",
      instagramUrl: input.instagramUrl ?? "",
      telegramUrl: input.telegramUrl ?? "",
    }),
  });
  if (result.ok) revalidatePath("/settings/links");
  return result;
}
