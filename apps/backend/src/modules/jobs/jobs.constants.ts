export const SWEEPS_QUEUE = "sweeps";
export const ANNOUNCEMENTS_QUEUE = "announcements";

/** How long an unpaid subscription may sit before it counts as abandoned.
 *
 * Generous on purpose. A card payment finishes in a minute, but a crypto
 * payment waits on block confirmations, and cancelling one that is still
 * legitimately in flight would be far worse than leaving a dead row an
 * extra hour. Anything this old was not going to be paid. */
export const STALE_PENDING_AFTER_MS = 6 * 60 * 60 * 1000;
