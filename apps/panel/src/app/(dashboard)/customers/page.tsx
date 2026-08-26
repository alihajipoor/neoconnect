import { apiFetchList } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { Customer } from "@/lib/types";
import { Pager, pageWindow } from "@/components/dashboard/pager";
import { CustomersTable } from "./customers-table";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ take?: string; skip?: string }>;
}) {
  await requireStaff();
  const { take: takeParam, skip: skipParam } = await searchParams;
  const { take, skip } = pageWindow({ take: takeParam, skip: skipParam });

  const query = new URLSearchParams({ take: String(take) });
  if (skip > 0) query.set("skip", String(skip));

  const customers = await apiFetchList<Customer>(`/customers?${query.toString()}`);

  return (
    <div className="flex flex-col gap-4">
      <CustomersTable customers={customers.items} />
      <Pager total={customers.total} take={take} skip={skip} basePath="/customers" />
    </div>
  );
}
