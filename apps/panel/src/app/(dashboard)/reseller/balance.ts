import type { ResellerBalance } from "@/lib/types";

/** Whether a reseller can mint a code from this balance. A plan the
 * operator has retired keeps its balance -- the reseller paid for it --
 * but the backend refuses to mint for it, because nobody could redeem the
 * code. */
export function canMintFrom(b: ResellerBalance): boolean {
  return b.balance > 0 && b.plan.isActive !== false;
}

/** The plan an activation will use: the one picked, while it can still
 * be spent from, and otherwise the first that can. The balances change
 * under the form every time something is spent, so a plan picked a
 * moment ago may have just run out. Empty when there is nothing left. */
export function planToActivate(balances: ResellerBalance[], picked: string): string {
  const spendable = balances.filter(canMintFrom);
  return (spendable.find((b) => b.plan.id === picked) ?? spendable[0])?.plan.id ?? "";
}

export function balanceLabel(b: ResellerBalance): string {
  return b.plan.isActive === false ? `${b.plan.name} — no longer offered` : `${b.plan.name} — ${b.balance} left`;
}
