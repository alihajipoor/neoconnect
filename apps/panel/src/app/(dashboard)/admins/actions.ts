"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { AdminRole, AdminUser } from "@/lib/types";

export async function createAdmin(input: {
  email: string;
  password: string;
  role: AdminRole;
}): Promise<MutationResult<AdminUser>> {
  const result = await apiMutate<AdminUser>("/admins", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/admins");
  return result;
}

export async function updateAdmin(
  id: string,
  input: { password?: string; role?: AdminRole },
): Promise<MutationResult<AdminUser>> {
  const result = await apiMutate<AdminUser>(`/admins/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/admins");
  return result;
}

export async function deleteAdmin(id: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>(`/admins/${id}`, { method: "DELETE" });
  if (result.ok) revalidatePath("/admins");
  return result;
}
