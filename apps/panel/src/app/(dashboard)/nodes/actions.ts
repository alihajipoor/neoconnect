"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { Node, NodeRole } from "@/lib/types";

export async function createNode(input: {
  name: string;
  role: NodeRole;
  region: string;
  publicIp: string;
}): Promise<MutationResult<Node>> {
  const result = await apiMutate<Node>("/nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/nodes");
  return result;
}

export async function deleteNode(id: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>(`/nodes/${id}`, { method: "DELETE" });
  if (result.ok) revalidatePath("/nodes");
  return result;
}

export interface EnrollmentToken {
  token: string;
  expiresAt: string;
}

export async function issueEnrollmentToken(nodeId: string): Promise<MutationResult<EnrollmentToken>> {
  return apiMutate<EnrollmentToken>(`/nodes/${nodeId}/enrollment-tokens`, { method: "POST" });
}
