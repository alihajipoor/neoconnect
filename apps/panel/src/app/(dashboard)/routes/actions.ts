"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import { redactResult, withoutRouteSecrets } from "@/lib/redact";
import type { Route } from "@/lib/types";

export async function createRoute(input: {
  name: string;
  entryProtocolConfigId: string;
  exitProtocolConfigId?: string;
  isEnabled?: boolean;
}): Promise<MutationResult<Route>> {
  const result = await apiMutate<Route>("/routes", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/routes");
  // A relay's create answer carries the uplink credential it minted on
  // the exit node, and this return value reaches the browser.
  return redactResult(result, withoutRouteSecrets);
}

export async function deleteRoute(id: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>(`/routes/${id}`, { method: "DELETE" });
  if (result.ok) revalidatePath("/routes");
  return result;
}
