import type { KeepJobs } from "bullmq";

export const SWEEPS_QUEUE = "sweeps";
export const ANNOUNCEMENTS_QUEUE = "announcements";

/** What stays in Redis of a job once it has finished.
 *
 * BullMQ keeps every finished job for ever unless told otherwise, and for
 * the first months nothing here told it: by 2026-11-12 the sweeps queue
 * held about 65,000 completed runs, growing by about 870 a day.
 *
 * Each setting is given in three places, and each place covers something
 * the others do not:
 *
 *   - the worker (@Processor) -- the one that reaches the repeat chains
 *     already running. A repeat job hands its own options to its next
 *     run, so a chain started before this existed carries none, and
 *     adding the job again at startup does not replace a next run that
 *     is already scheduled. The worker's setting applies to any job that
 *     has none of its own;
 *   - the queue's defaults (registerQueue) -- for whatever is added
 *     through the queue from now on;
 *   - each repeat job (SweepsSchedulerService), so a chain started on an
 *     empty Redis carries them from its first run.
 *
 * Nothing reads a finished job: what a run did is in the log. They are
 * kept only long enough to answer "did it run, and did it fail". */
export interface FinishedJobs {
  removeOnComplete: KeepJobs;
  removeOnFail: KeepJobs;
}

const DAY_S = 24 * 60 * 60;

/** A day of completed runs, about 870 jobs, so last night's retention run
 * can still be seen in the morning. Failures for a week, and never more
 * than 500.
 *
 * Completed runs are bounded by age alone on purpose. BullMQ removes at
 * most 1,000 expired jobs each time a job finishes, but a `count` is
 * enforced in one call however far over it the queue is -- which, on the
 * first run after this shipped, would have been some 65,000 deletions in
 * a single script with Redis answering nobody else meanwhile. By age,
 * that backlog goes a thousand at a time. */
export const SWEEPS_FINISHED: FinishedJobs = {
  removeOnComplete: { age: DAY_S },
  removeOnFail: { age: 7 * DAY_S, count: 500 },
};

/** By count, not age: age is only looked at when another job finishes,
 * and announcements are sent weeks apart. Kept shorter than it might be
 * because a finished announcement still carries its whole recipient
 * list. */
export const ANNOUNCEMENTS_FINISHED: FinishedJobs = {
  removeOnComplete: { count: 10 },
  removeOnFail: { count: 50 },
};

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
