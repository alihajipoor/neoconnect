"use server";

import { revalidatePath } from "next/cache";
import { apiMutate, type MutationResult } from "@/lib/api";
import type { Customer, CustomerStatus } from "@/lib/types";

export async function createCustomer(input: {
  email: string;
  password: string;
  telegramId?: string;
}): Promise<MutationResult<Customer>> {
  const result = await apiMutate<Customer>("/customers", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/customers");
  return result;
}

export async function updateCustomer(
  id: string,
  input: { telegramId?: string; status?: CustomerStatus; password?: string },
): Promise<MutationResult<Customer>> {
  const result = await apiMutate<Customer>(`/customers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/customers");
  return result;
}

export async function deleteCustomer(id: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>(`/customers/${id}`, { method: "DELETE" });
  if (result.ok) revalidatePath("/customers");
  return result;
}
