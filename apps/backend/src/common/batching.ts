/** How the *internal* reads in this API are bounded.
 *
 * `common/pagination.ts` is the convention for list **routes** -- a
 * caller asks for a window and gets one. This file is the convention for
 * the other kind: cron sweeps, boot backfills and re-assert loops, which
 * have no caller to ask for a page and must process **every** matching
 * row before they are allowed to report success.
 *
 * The pagination pass of 2026-08-26 audited 66 `findMany` calls and left
 * seventeen of these deliberately untouched, with its reasoning written
 * down. It is worth repeating because it is the whole point of this
 * file:
 *
 * > **A `take` on any of them silently drops work.** A sweep that
 * > expires 100 of 300 due subscriptions leaves 200 live and reports
 * > success.
 *
 * A cap is the wrong tool. What these need is a **cursor**: the same
 * bounded memory a `take` buys, but with the window advancing until
 * there is nothing left, so the row count is a fact about the database
 * rather than a number the code chose.
 *
 * ## Why an explicit `id: { gt }` and not Prisma's `cursor:`
 *
 * Prisma has `cursor`/`skip: 1` pagination and it is not used here, on
 * purpose. Roughly half of these sweeps **invalidate their own `where`
 * as they go** -- `sweepQuota` flips ACTIVE to SUSPENDED,
 * `sweepExpiryWarnings` stamps `expiryWarningSentAt`, `markOverdue`
 * flips ISSUED to OVERDUE. By the time the next batch is read, the row
 * the cursor points at no longer satisfies the filter it was found
 * under, and "what does a cursor mean when the cursor row has left the
 * result set" is a question this code should not have to be right about.
 *
 * `WHERE <predicate> AND id > $last ORDER BY id ASC LIMIT n` has no such
 * question. It is a comparison against a value, not a lookup of a row,
 * so it behaves identically whether the previous batch changed those
 * rows or not. It is also plainly visible in the `where` a unit test
 * asserts on, which is what lets the tests below discriminate a real
 * cursor from a `take` that merely looks like one.
 *
 * `id` is a random UUID rather than a sequence, so the order is
 * arbitrary -- but it is *total* and *stable*, which is all a cursor
 * needs. Do not use this for a sweep whose order is load-bearing
 * (`replayQueuedCommands` orders by `createdAt` and means it); that one
 * needs a `(createdAt, id)` cursor and is not converted here.
 *
 * ## What a failure does
 *
 * Nothing here retries and nothing here swallows. If the handler throws,
 * the sweep stops and raises {@link SweepAbortedError}, which carries
 * how far it got. That is deliberate: a sweep that dies half way IS
 * partial, and the only bad outcome is it being partial *quietly*. The
 * job fails, the message says "aborted after 1,500 rows in 3 batches",
 * and the next scheduled run picks up what was missed because every one
 * of these predicates still matches the rows that were not handled.
 *
 * Per-row failures are a different thing and stay the caller's business
 * -- several of these sweeps already catch per row and count failures so
 * one bad subscription cannot deny every later one its turn.
 */

/** Rows one batch reads.
 *
 * 500 because the bound that matters here is **memory**, not time: every
 * one of these loops does per-row I/O in its body -- an email, a gRPC
 * command, a write -- so the wall clock is set by the row count and the
 * batch size cannot change it. What the batch size controls is how much
 * is resident at once, and 500 rows of the narrow projections these
 * sweeps select is tens of kilobytes: small enough to be irrelevant
 * against a Node heap, large enough that the extra round trip per batch
 * disappears against the work each batch then does.
 *
 * It is the same number as `maxTake` on the list routes in
 * `pagination.ts`, so there is one "how many rows is a lot" in this
 * codebase rather than two that can drift apart.
 */
export const SWEEP_BATCH_SIZE = 500;

/** A stop before the loop can become an infinite one.
 *
 * The only way to spin forever is a `read` that ignores the cursor it is
 * handed, which is a programming error rather than a data condition. At
 * {@link SWEEP_BATCH_SIZE} this is a million rows -- orders of magnitude
 * past anything real -- so hitting it means the bug, not the backlog.
 * It throws rather than returning, because stopping quietly is the exact
 * failure this whole file exists to remove.
 */
export const MAX_SWEEP_BATCHES = 2_000;

/** The minimum a row must be for {@link forEachBatch} to cursor on it. */
export interface CursorRow {
  id: string;
}

export interface SweepProgress {
  /** Rows read and handed to the handler, across every batch. */
  rows: number;
  /** Batches it took, including the final empty one that ended it. */
  batches: number;
}

/** Raised when a handler throws part way through, carrying how far the
 * sweep had got. Preserves the original error as `cause`. */
export class SweepAbortedError extends Error {
  constructor(
    readonly label: string,
    readonly progress: SweepProgress,
    override readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${label} aborted after ${progress.rows} rows in ${progress.batches} batches: ${reason}`);
    this.name = "SweepAbortedError";
  }
}

export interface BatchSweep<T extends CursorRow> {
  /** Named in errors and logs. Use the method name. */
  label: string;
  /** Reads the next batch. Must apply `id: { gt: afterId }` when
   * `afterId` is given, `orderBy: { id: "asc" }`, and `take`. */
  read: (afterId: string | undefined, take: number) => Promise<T[]> | T[];
  /** Handles one batch. Throwing aborts the sweep loudly.
   *
   * May be synchronous. Both this and `read` are awaited either way, and
   * a handler with nothing to await is a legitimate shape -- requiring a
   * promise would only push callers into writing `async` functions that
   * never suspend. */
  handle: (rows: T[]) => Promise<void> | void;
  batchSize?: number;
  maxBatches?: number;
}

/** Runs `read`/`handle` until `read` comes back empty.
 *
 * Stops on an empty batch rather than on a short one. A short batch does
 * imply the end for the query shape above, but "empty" is true for any
 * shape a caller might write, and one extra round trip per sweep is not
 * worth being clever about.
 */
export async function forEachBatch<T extends CursorRow>(sweep: BatchSweep<T>): Promise<SweepProgress> {
  const batchSize = sweep.batchSize ?? SWEEP_BATCH_SIZE;
  const maxBatches = sweep.maxBatches ?? MAX_SWEEP_BATCHES;
  const progress: SweepProgress = { rows: 0, batches: 0 };
  let afterId: string | undefined;

  while (progress.batches < maxBatches) {
    const rows = await sweep.read(afterId, batchSize);
    progress.batches += 1;
    if (rows.length === 0) return progress;

    progress.rows += rows.length;
    try {
      await sweep.handle(rows);
    } catch (err) {
      throw new SweepAbortedError(sweep.label, progress, err);
    }

    // Read before the handler is given a chance to mutate the array.
    const last = rows[rows.length - 1];
    if (last.id === afterId) {
      // The cursor did not move, so the next read would return the same
      // rows forever. Only reachable if `read` ignored `afterId`.
      throw new Error(
        `${sweep.label}: cursor did not advance past ${afterId} -- its read is ignoring the cursor`,
      );
    }
    afterId = last.id;
  }

  throw new Error(
    `${sweep.label}: gave up after ${maxBatches} batches (${progress.rows} rows) -- ` +
      `its read is almost certainly ignoring the cursor`,
  );
}

/** The `where` fragment a cursored read adds. Small, but it is the piece
 * that must not be forgotten, so it has a name and a single definition
 * every converted sweep uses. */
export function after(afterId: string | undefined): { id: { gt: string } } | Record<string, never> {
  return afterId === undefined ? {} : { id: { gt: afterId } };
}
