import { redirect } from "next/navigation";
import { apiFetch, apiFetchList } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { ResellerBalance, ResellerVoucher } from "@/lib/types";
import { pageWindow } from "@/components/dashboard/pager";
import { ResellerWorkspace } from "./reseller-workspace";

/**
 * The reseller's own section: what they can still mint, and what they
 * have minted.
 *
 * Open to RESELLER and SUPERADMIN. The operator is allowed in so they
 * can see exactly what a reseller sees while helping one -- but they see
 * their OWN codes here, not everyone's, because the backend scopes on
 * the caller's id. The operator's view of all resellers is /resellers.
 */
export default async function ResellerPage({
  searchParams,
}: {
  searchParams: Promise<{ take?: string; skip?: string }>;
}) {
  const session = await getSession();
  if (session?.role !== "RESELLER" && session?.role !== "SUPERADMIN") {
    redirect("/overview");
  }

  const { take: takeParam, skip: skipParam } = await searchParams;
  const { take, skip } = pageWindow({ take: takeParam, skip: skipParam });

  const query = new URLSearchParams({ take: String(take) });
  if (skip > 0) query.set("skip", String(skip));

  // The total that comes back with this page is the reseller's own:
  // `myVouchers` counts over the same `issuedByAdminId` WHERE clause it
  // pages, so the figure the workspace prints is codes *they* issued and
  // never the whole voucher table's.
  const [balances, vouchers] = await Promise.all([
    apiFetch<ResellerBalance[]>("/reseller/balances"),
    apiFetchList<ResellerVoucher>(`/reseller/vouchers?${query.toString()}`),
  ]);

  return (
    <ResellerWorkspace
      balances={balances}
      vouchers={vouchers.items}
      issuedTotal={vouchers.total}
      take={take}
      skip={skip}
    />
  );
}
