"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { ProtocolConfig, Protocol } from "@/lib/types";

export async function createProtocolConfig(input: {
  nodeId: string;
  protocol: Protocol;
  listenPort: number;
  publicParamsJson: Record<string, unknown>;
  isEnabled?: boolean;
}): Promise<MutationResult<ProtocolConfig>> {
  const result = await apiMutate<ProtocolConfig>("/protocol-configs", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/protocol-configs");
  return result;
}

export async function deleteProtocolConfig(id: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>(`/protocol-configs/${id}`, { method: "DELETE" });
  if (result.ok) revalidatePath("/protocol-configs");
  return result;
}
