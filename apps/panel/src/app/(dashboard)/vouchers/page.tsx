import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { SubscriptionPlan, Voucher } from "@/lib/types";
import { VouchersTable } from "./vouchers-table";

export default async function VouchersPage() {
  await requireStaff();
  const [vouchers, plans] = await Promise.all([
    apiFetch<Voucher[]>("/vouchers"),
    apiFetch<SubscriptionPlan[]>("/plans"),
  ]);
  return <VouchersTable vouchers={vouchers} plans={plans} />;
}
