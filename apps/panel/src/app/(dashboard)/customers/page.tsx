import { apiFetch } from "@/lib/api";
import type { Customer } from "@/lib/types";
import { CustomersTable } from "./customers-table";

export default async function CustomersPage() {
  const customers = await apiFetch<Customer[]>("/customers");
  return <CustomersTable customers={customers} />;
}
