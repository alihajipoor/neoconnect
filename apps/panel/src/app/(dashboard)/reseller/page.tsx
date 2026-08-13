import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { ResellerBalance, ResellerVoucher } from "@/lib/types";
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
export default async function ResellerPage() {
  const session = await getSession();
  if (session?.role !== "RESELLER" && session?.role !== "SUPERADMIN") {
    redirect("/overview");
  }

  const [balances, vouchers] = await Promise.all([
    apiFetch<ResellerBalance[]>("/reseller/balances"),
    apiFetch<ResellerVoucher[]>("/reseller/vouchers"),
  ]);

  return <ResellerWorkspace balances={balances} vouchers={vouchers} />;
}
