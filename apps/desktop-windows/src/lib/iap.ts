import { invoke } from "@tauri-apps/api/core";

import { apiRequest } from "./api";
import { getPlans } from "./customer";
import { IS_STORE_BUILD } from "./distribution";
import type { ApiResult } from "./api";
import type { SubscriptionPlan } from "./types";

/** Buying a plan through the App Store.
 *
 * Only reachable in a store build on iOS. Everywhere else the customer
 * buys on the web, and Apple takes nothing from those sales because
 * they never touch the App Store.
 *
 * The order of operations is the whole design and it is deliberately
 * not the obvious one. StoreKit takes the money and hands back a signed
 * transaction; our server verifies that signature and grants the
 * subscription; and only then is the transaction *finished*. Finishing
 * is StoreKit's record that the purchase was delivered, so doing it
 * before the server agrees would lose the sale outright if the network
 * dropped in between -- the customer charged, owning nothing, with no
 * receipt left to replay.
 *
 * `sweepUnfinished` is the other half of that: a purchase that was paid
 * for but never granted is still sitting in StoreKit on the next
 * launch, and this is what picks it up.
 */

const isIOS = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** Whether to offer in-app purchase at all.
 *
 * All three conditions matter. Store build, because the direct APK and
 * the desktop client sell on the web and must keep doing so. iOS,
 * because StoreKit is an Apple API. And the native runtime, because the
 * web portal reuses these screens and has no plugin to call.
 */
export function iapAvailable(): boolean {
  return (
    IS_STORE_BUILD &&
    isIOS() &&
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

export interface IapPlan {
  planId: string;
  productId: string;
  /** Apple's own localised price, shown verbatim. Our USD figure would
   * be the wrong number in the wrong currency for most of the world,
   * and Apple requires its price to be the displayed one. */
  displayPrice: string;
  name: string;
  durationDays: number;
  dataCapBytes: string | null;
}

interface NativeProduct {
  id: string;
  displayName: string;
  displayPrice: string;
}

/** The plans this device can buy, priced by the App Store.
 *
 * Two sources joined: our API says which plans exist and what they
 * include, StoreKit says what they cost here. A plan our API lists but
 * StoreKit does not know is dropped rather than shown at our own price
 * -- that combination means a product is missing or not yet approved in
 * App Store Connect, and showing a price the customer cannot be charged
 * is worse than showing nothing.
 */
export async function loadIapPlans(): Promise<ApiResult<IapPlan[]>> {
  const plans = await getPlans();
  if (!plans.ok) return plans;

  const withProducts = plans.data.filter(
    (p): p is SubscriptionPlan & { appleProductId: string } => Boolean(p.appleProductId),
  );
  if (withProducts.length === 0) return { ok: true, data: [] };

  let native: { products: NativeProduct[] };
  try {
    native = await invoke<{ products: NativeProduct[] }>("vpn_iap_products", {
      productIds: withProducts.map((p) => p.appleProductId),
    });
  } catch {
    // StoreKit could not be reached, which is not the same as "no plans
    // for sale". Reported as a failure so the screen can say so rather
    // than showing an empty list that reads as "nothing available".
    return { ok: false, error: "Could not reach the App Store. Please try again." };
  }

  const priced = new Map(native.products.map((p) => [p.id, p]));
  return {
    ok: true,
    data: withProducts.flatMap((plan) => {
      const product = priced.get(plan.appleProductId);
      if (!product) return [];
      return [
        {
          planId: plan.id,
          productId: plan.appleProductId,
          displayPrice: product.displayPrice,
          name: plan.name,
          durationDays: plan.durationDays,
          dataCapBytes: plan.dataCapBytes ?? null,
        },
      ];
    }),
  };
}

interface RedeemResult {
  subscriptionId: string | null;
  alreadyRedeemed: boolean;
}

/** The StoreKit transaction id inside a signed transaction, or null.
 *
 * Read from the JWS payload rather than carried beside it, so the
 * recovery sweep needs nothing new from the native side. Unverified on
 * purpose: it only names which local transaction to finish, after our
 * server -- which does verify the signature -- has accepted this exact
 * JWS. StoreKit writes the id as a decimal string. */
export function transactionIdOf(signedTransaction: string): string | null {
  const payload = signedTransaction.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const id = (JSON.parse(atob(padded)) as { transactionId?: unknown }).transactionId;
    if (typeof id === "string" && /^\d+$/.test(id)) return id;
    if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) return String(id);
    return null;
  } catch {
    return null;
  }
}

/** Hands a signed transaction to our server and, if it is accepted,
 * tells StoreKit that one purchase has been delivered.
 *
 * Only the transaction named. A null id finishes nothing: it used to
 * mean "finish every unfinished transaction", so the recovery sweep,
 * having redeemed the first of two, finished both -- and if the second
 * one's redeem then failed, StoreKit never offered it again and the
 * customer had paid for something nothing would ever grant. Left
 * unfinished instead, it is redeemed again on the next launch, which
 * the server answers as a no-op. */
async function redeemAndFinish(
  signedTransaction: string,
  transactionId: string | null,
): Promise<ApiResult<RedeemResult>> {
  const result = await apiRequest<RedeemResult>("/customer/billing/apple/redeem", {
    method: "POST",
    body: JSON.stringify({ signedTransaction }),
  });
  if (!result.ok) return result;
  if (transactionId === null) return result;

  // Only now. If this throws, the transaction stays unfinished and the
  // next launch retries it -- which is the correct failure, because the
  // subscription has already been granted and a second redemption is a
  // no-op on the server.
  try {
    await invoke("vpn_iap_finish", { transactionId });
  } catch {
    // Nothing to tell the customer: they have what they paid for.
  }
  return result;
}

/** Buys a plan. Returns null if the customer cancelled, which is not an
 * error and must not be shown as one. */
export async function buyIapPlan(productId: string): Promise<ApiResult<RedeemResult> | null> {
  let purchase: { signedTransaction: string | null; transactionId?: string; pending?: boolean };
  try {
    purchase = await invoke("vpn_iap_purchase", { productId });
  } catch (err) {
    const code = err instanceof Error ? err.message : String(err);
    return { ok: false, error: purchaseErrorMessage(code) };
  }

  if (purchase.pending) {
    // Ask to Buy, or a payment method needing action elsewhere. The
    // purchase may still complete later, and the launch sweep will pick
    // it up, so this is not a failure either.
    return {
      ok: false,
      error: "Your purchase needs approval before it can complete. It will appear here once it does.",
    };
  }
  if (!purchase.signedTransaction) return null;

  return redeemAndFinish(
    purchase.signedTransaction,
    purchase.transactionId ?? transactionIdOf(purchase.signedTransaction),
  );
}

/** Grants anything that was paid for but never delivered.
 *
 * Runs on launch. A customer whose app died between paying Apple and
 * reaching our API has been charged for something they do not have, and
 * StoreKit holding the unfinished transaction is the only record left.
 * Returns how many were recovered, for the caller to report if it wants.
 */
export async function sweepUnfinishedPurchases(): Promise<number> {
  if (!iapAvailable()) return 0;

  let unfinished: { signedTransactions: string[] };
  try {
    unfinished = await invoke("vpn_iap_unfinished");
  } catch {
    return 0;
  }

  let recovered = 0;
  for (const jws of unfinished.signedTransactions) {
    // Deliberately serial. These are rare, and a burst of parallel
    // redemptions against the same account is exactly the race the
    // server's unique constraint exists to catch -- no reason to
    // provoke it. Each finishes only itself; see redeemAndFinish.
    const result = await redeemAndFinish(jws, transactionIdOf(jws));
    if (result.ok) recovered += 1;
  }
  return recovered;
}

function purchaseErrorMessage(code: string): string {
  switch (code) {
    case "iap-unknown-product":
      return "That plan is not available on the App Store right now.";
    case "iap-unverified":
      return "The App Store could not verify that purchase.";
    default:
      return "That purchase did not complete. You have not been charged twice -- if money left your account, reopen the app and it will be applied.";
  }
}
