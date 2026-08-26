import { apiFetch, apiFetchList } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { SubscriptionPlan, VoucherListRow } from "@/lib/types";
import { Pager, pageWindow } from "@/components/dashboard/pager";
import { VouchersTable } from "./vouchers-table";

export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Promise<{ take?: string; skip?: string }>;
}) {
  await requireStaff();
  const { take: takeParam, skip: skipParam } = await searchParams;
  const { take, skip } = pageWindow({ take: takeParam, skip: skipParam });

  const query = new URLSearchParams({ take: String(take) });
  if (skip > 0) query.set("skip", String(skip));

  // /plans is deliberately not windowed alongside it: the dialog's plan
  // dropdown has to offer every plan a voucher could grant, and paging a
  // catalogue of a dozen rows would mean the form could only reach the
  // first page of them.
  const [vouchers, plans] = await Promise.all([
    apiFetchList<VoucherListRow>(`/vouchers?${query.toString()}`),
    apiFetch<SubscriptionPlan[]>("/plans"),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <VouchersTable vouchers={vouchers.items} plans={plans} />
      <Pager total={vouchers.total} take={take} skip={skip} basePath="/vouchers" />
    </div>
  );
}
