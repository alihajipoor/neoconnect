"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { AppLinks } from "@/lib/types";

export async function updateAppLinks(input: AppLinks): Promise<MutationResult<AppLinks>> {
  const result = await apiMutate<AppLinks>("/app-links", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/settings/links");
  return result;
}
