import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { Customer } from "@/lib/types";
import { CustomersTable } from "./customers-table";

export default async function CustomersPage() {
  await requireStaff();
  const customers = await apiFetch<Customer[]>("/customers");
  return <CustomersTable customers={customers} />;
}
