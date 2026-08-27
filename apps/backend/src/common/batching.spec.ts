import { forEachBatch, SweepAbortedError, SWEEP_BATCH_SIZE, after } from "./batching";
import { cursoredFindMany, rowIds } from "../../test/cursored";

/** The cursor loop itself.
 *
 * These are the properties every converted sweep inherits, tested once
 * here rather than nine times over -- the sweeps' own specs then only
 * have to show that they wired it up, not that it works.
 */
describe("forEachBatch", () => {
  /** A `read` shaped the way a converted sweep shapes it. */
  function readerOver(ids: string[]) {
    const findMany = cursoredFindMany(ids.map((id) => ({ id })));
    return {
      findMany,
      read: (afterId: string | undefined, take: number) =>
        findMany({ where: { ...after(afterId) }, orderBy: { id: "asc" }, take }),
    };
  }

  it("sees every row when there are more of them than one batch holds", async () => {
    const { read } = readerOver(rowIds(250));
    const seen: string[] = [];

    const progress = await forEachBatch({
      label: "test",
      batchSize: 100,
      read,
      handle: (rows) => {
        for (const row of rows) seen.push(row.id);
      },
    });

    // 250, not 100. This is the whole point: a `take` would have
    // returned a truthful-looking 100 and left 150 unprocessed.
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    expect(progress.rows).toBe(250);
  });

  it("carries the cursor forward, so no batch repeats the last one", async () => {
    const { findMany, read } = readerOver(rowIds(250));

    await forEachBatch({ label: "test", batchSize: 100, read, handle: () => undefined });

    // 100, 100, 50, then the empty read that ends it.
    expect(findMany.wheres).toHaveLength(4);
    expect(findMany.wheres[0]).toEqual({});
    expect(findMany.wheres[1]).toEqual({ id: { gt: "row-099" } });
    expect(findMany.wheres[2]).toEqual({ id: { gt: "row-199" } });
    expect(findMany.wheres[3]).toEqual({ id: { gt: "row-249" } });
  });

  it("handles a row set that fits in one batch without a second pass over it", async () => {
    const { read } = readerOver(rowIds(3));
    const seen: string[] = [];

    await forEachBatch({
      label: "test",
      batchSize: 100,
      read,
      handle: (rows) => {
        for (const row of rows) seen.push(row.id);
      },
    });

    expect(seen).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("does nothing at all when there is nothing to do", async () => {
    const { read } = readerOver([]);
    const handle = jest.fn();

    const progress = await forEachBatch({ label: "test", read, handle });

    expect(handle).not.toHaveBeenCalled();
    expect(progress.rows).toBe(0);
  });

  /** The failure mode this whole file exists to remove is a sweep that
   * stops early and says nothing. So a handler that throws must not be
   * swallowed, and the error must say how far it got -- "it failed" is
   * far less useful than "it failed after 200 rows", because the second
   * tells an operator what state the database is in. */
  it("raises a failure that says how far it got, rather than reporting success", async () => {
    const { read } = readerOver(rowIds(250));
    let seen = 0;

    const sweep = forEachBatch({
      label: "sweepThing",
      batchSize: 100,
      read,
      handle: (rows) => {
        seen += rows.length;
        if (seen >= 200) throw new Error("the mailer fell over");
      },
    });

    await expect(sweep).rejects.toBeInstanceOf(SweepAbortedError);
    await expect(sweep).rejects.toThrow("sweepThing aborted after 200 rows in 2 batches");
    // The original cause survives, so the actual fault is not buried.
    await expect(sweep).rejects.toThrow("the mailer fell over");
  });

  it("keeps the original error as the cause", async () => {
    const { read } = readerOver(rowIds(2));
    const cause = new Error("underlying");

    await forEachBatch({
      label: "s",
      read,
      handle: () => {
        throw cause;
      },
    }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(SweepAbortedError);
      expect((err as SweepAbortedError).cause).toBe(cause);
      expect((err as SweepAbortedError).progress).toEqual({ rows: 2, batches: 1 });
    });
    expect.assertions(3);
  });

  /** A `read` that ignores its cursor would loop on the same page for
   * ever. That is a programming error, and the loop must die loudly
   * rather than spin -- a hung boot backfill is harder to diagnose than
   * a crashed one. */
  it("refuses to spin when a read ignores the cursor it was handed", async () => {
    const rows = rowIds(10).map((id) => ({ id }));

    await expect(
      forEachBatch({
        label: "brokenSweep",
        batchSize: 5,
        // The bug: `afterId` is accepted and dropped on the floor.
        read: (_afterId, take) => rows.slice(0, take),
        handle: () => undefined,
      }),
    ).rejects.toThrow("brokenSweep: cursor did not advance past row-04");
  });

  it("gives up rather than running for ever if the cursor keeps changing but never finishes", async () => {
    let n = 0;

    await expect(
      forEachBatch({
        label: "endlessSweep",
        batchSize: 1,
        maxBatches: 5,
        // Always advances, never runs out.
        read: () => [{ id: `row-${(n += 1)}` }],
        handle: () => undefined,
      }),
    ).rejects.toThrow("endlessSweep: gave up after 5 batches (5 rows)");
  });

  it("bounds a batch at the documented size when the caller does not pick one", async () => {
    const takes: (number | undefined)[] = [];

    await forEachBatch({
      label: "test",
      read: (_afterId, take) => {
        takes.push(take);
        return [];
      },
      handle: () => undefined,
    });

    expect(takes).toEqual([SWEEP_BATCH_SIZE]);
  });
});

describe("after", () => {
  it("adds nothing to the first read, so the sweep starts at the beginning", () => {
    expect(after(undefined)).toEqual({});
  });

  it("is a comparison against a value, not a lookup of a row", () => {
    // Deliberately `gt` rather than Prisma's `cursor`: half these sweeps
    // change the rows they just read so they no longer match the filter
    // they were found under, and a comparison does not care.
    expect(after("row-7")).toEqual({ id: { gt: "row-7" } });
  });
});
