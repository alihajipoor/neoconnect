import type { ResellerBalance } from "@/lib/types";

/** Whether a reseller can mint a code from this balance. A plan the
 * operator has retired keeps its balance -- the reseller paid for it --
 * but the backend refuses to mint for it, because nobody could redeem the
 * code. */
export function canMintFrom(b: ResellerBalance): boolean {
  return b.balance > 0 && b.plan.isActive !== false;
}

export function balanceLabel(b: ResellerBalance): string {
  return b.plan.isActive === false ? `${b.plan.name} — no longer offered` : `${b.plan.name} — ${b.balance} left`;
}
