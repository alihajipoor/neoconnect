export const SWEEPS_QUEUE = "sweeps";
export const ANNOUNCEMENTS_QUEUE = "announcements";

/** How long an unpaid subscription may sit before it counts as abandoned.
 *
 * Generous on purpose. A card payment finishes in a minute, but a crypto
 * payment waits on block confirmations, and cancelling one that is still
 * legitimately in flight would be far worse than leaving a dead row an
 * extra hour. Measured from the attempt's last reuse (updatedAt).
 *
 * "Anything this old was not going to be paid" is not a guarantee: a
 * Stripe Checkout page stays payable for 24 hours. A payment that lands
 * after the cancel still activates the subscription, for one term --
 * see cancelStalePending and renewSubscription. */
export const STALE_PENDING_AFTER_MS = 6 * 60 * 60 * 1000;
