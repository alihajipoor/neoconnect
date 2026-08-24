"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { ProtocolConfig, Protocol } from "@/lib/types";

export async function createProtocolConfig(input: {
  nodeId: string;
  protocol: Protocol;
  listenPort: number;
  publicParamsJson: Record<string, unknown>;
  /** Which Xray inbound serves this config. Omitted, not null, when the
   * node default is wanted -- the create DTO has no null branch. */
  inboundTag?: string;
  isEnabled?: boolean;
}): Promise<MutationResult<ProtocolConfig>> {
  const result = await apiMutate<ProtocolConfig>("/protocol-configs", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/protocol-configs");
  return result;
}

export async function updateProtocolConfig(
  id: string,
  input: {
    listenPort?: number;
    publicParamsJson?: Record<string, unknown>;
    /** `null` clears the tag back to the node default; leaving the key
     * out leaves it alone. The two are different requests and the
     * backend treats them as such, so this must not collapse to
     * `undefined` on the way through. */
    inboundTag?: string | null;
    /** Acknowledges that a tag change strands customers already
     * provisioned. The backend refuses the change without it and says
     * how many. */
    confirmReprovision?: boolean;
    isEnabled?: boolean;
  },
): Promise<MutationResult<ProtocolConfig>> {
  const result = await apiMutate<ProtocolConfig>(`/protocol-configs/${id}`, {
    method: "PATCH",
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
