import type { TranslationKey } from "./i18n";

/** What to tell a customer whose subscription has stopped working.
 *
 * Split out of the dashboards because both clients need the identical
 * decision and because it is the one piece of this that can be tested
 * without a live account in a bad state -- putting it inline in the
 * component would have made "does an out-of-data customer see a way to
 * renew" a question nobody could answer except by exhausting a real
 * plan.
 */

/** Mirrors the backend's Subscription.status. */
export type SubscriptionStatus = "ACTIVE" | "SUSPENDED" | "EXPIRED" | "PENDING" | "CANCELLED";

export interface EndedNotice {
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  /** Whether to offer the in-app route to a plan.
   *
   * False in store builds, where the purchase flow is not merely hidden
   * but compiled out, and where pointing a customer at an outside
   * payment is itself against the rules. The message changes with it --
   * a card that explains the state and offers nothing is still better
   * than a button that cannot exist. */
  showPlansButton: boolean;
}

/** The notice for a subscription that exists but no longer entitles the
 * customer to connect, or null when there is nothing to say.
 *
 * SUSPENDED is what the backend sets when the data cap is reached, and
 * EXPIRED when the term ends -- see UsageService. Both stay visible on
 * the dashboard rather than being filtered out like PENDING and
 * CANCELLED, which is right: they are real subscriptions, and hiding
 * one would leave the customer with an account that appears to have
 * nothing in it.
 *
 * What was missing is this. The connect error already told them to
 * "upgrade or wait for it to renew" while the screen offered no way to
 * do either -- the exact moment a customer is most willing to pay, and
 * a dead end on every client.
 */
export function endedNotice(
  status: SubscriptionStatus,
  isStoreBuild: boolean,
): EndedNotice | null {
  if (status !== "SUSPENDED" && status !== "EXPIRED") return null;

  return {
    titleKey: status === "SUSPENDED" ? "dash.outOfData" : "dash.planExpired",
    // Direct builds sell; store builds send them back to wherever they
    // bought it, without naming a destination or offering a link.
    bodyKey: isStoreBuild ? "dash.renewStore" : "dash.renewHint",
    showPlansButton: !isStoreBuild,
  };
}
