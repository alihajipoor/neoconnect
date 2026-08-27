/** A Prisma `findMany` double that honours a cursor.
 *
 * The specs in this repo mock Prisma with plain object literals, and for
 * a single-shot read `jest.fn().mockResolvedValue(rows)` is exactly
 * right. It stops being right the moment the code under test reads in
 * batches, because a `mockResolvedValue` hands back **the same rows
 * forever** -- which is not a slow test, it is a test that cannot tell a
 * working cursor from a broken one. Both look like "the rows came back".
 *
 * This is the same query shape `common/batching.ts` asks its callers to
 * write, and nothing more: `where.id.gt` for the cursor, `take` for the
 * size, ascending order by `id`. It deliberately does **not** evaluate
 * the rest of the `where` -- a spec controls what the sweep sees by
 * choosing the rows it passes in, and reimplementing Prisma's filter
 * semantics here would only create a second thing to be wrong.
 *
 * Two properties are what make a test written against it discriminate:
 *
 * - It **respects `take`**, so a sweep over more rows than one batch
 *   really does need more than one read to see them all. Give it 250
 *   rows and a batch size of 100 and a sweep that drops the cursor will
 *   process 100.
 * - It **advances**, so a correct sweep terminates and an incorrect one
 *   is caught by `forEachBatch`'s own guard rather than hanging.
 */
export interface CursoredFindManyArgs {
  where?: { id?: { gt?: string } } & Record<string, unknown>;
  take?: number;
  orderBy?: unknown;
  [key: string]: unknown;
}

/** Deliberately a bare `jest.Mock` rather than a parameterised one.
 *
 * The specs here reach into `.mock.calls[0][0].where` and re-point the
 * double with `mockResolvedValue` for a differently shaped query on the
 * same model, both of which a pinned signature turns into a type error
 * for no safety gained -- the rows are fixtures, not a contract. Only
 * `wheres` is typed, because that is the part a test asserts against. */
export interface CursoredFindMany<T> extends jest.Mock {
  /** Every `where` this was called with, in order. Lets a test assert
   * that the second read actually carried a cursor. */
  wheres: (CursoredFindManyArgs["where"] | undefined)[];
  /** Present only so `T` is used; the rows themselves are untyped at the
   * call boundary for the reason above. */
  readonly __row?: T;
}

/** Builds the double over a fixed set of rows.
 *
 * Rows are sorted by `id` once, up front, so the order the caller
 * happens to declare them in cannot change what the cursor means. */
export function cursoredFindMany<T extends { id: string }>(rows: T[]): CursoredFindMany<T> {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Not `async`: there is nothing to await, and the caller awaits the
  // result either way.
  const mock = jest.fn((args?: CursoredFindManyArgs) => {
    mock.wheres.push(args?.where);
    const gt = args?.where?.id?.gt;
    const remaining = gt === undefined ? sorted : sorted.filter((row) => row.id > gt);
    // `take` absent means "everything", which is precisely the bug these
    // tests exist to catch -- so it is honoured as written rather than
    // defaulted to something safe.
    return Promise.resolve(args?.take === undefined ? remaining : remaining.slice(0, args.take));
  }) as CursoredFindMany<T>;

  mock.wheres = [];
  return mock;
}

/** Ids for `n` rows that sort in the order they are generated.
 *
 * Zero-padded because the cursor compares strings: without the padding
 * `row-10` sorts before `row-2`, and a test whose rows come back in an
 * order it did not intend is a test that proves nothing about batching.
 */
export function rowIds(n: number, prefix = "row"): string[] {
  const width = String(n).length;
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(width, "0")}`);
}
