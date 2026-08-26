import type { Response } from "express";

/** How the list endpoints in this API are bounded.
 *
 * Written down here because there was no convention at all: on
 * 2026-08-25 the backend had 66 `findMany` calls and two `take` clauses
 * between them, and the one route that had grown large enough to notice
 * -- the 1,480-row game catalogue -- was being sent in full to the panel
 * on page load. Compression was added in the same pass and made the wire
 * cost 7x better, which is worth having and is **not** a bound: an
 * unbounded query still reads every row, still holds the whole result in
 * memory, and still serialises all of it before the compressor sees a
 * byte.
 *
 * The shape of the convention is chosen around one hard constraint.
 * There are shipped desktop clients in the field that cannot be updated
 * in step with the server, so a list route may not change what its body
 * looks like. Therefore:
 *
 * - **The body stays a bare JSON array.** No `{ items, total }` envelope.
 *   A client that knows nothing about paging keeps parsing exactly what
 *   it parsed before.
 * - **Paging is opt-in through query parameters**, `take` and `skip`.
 *   A caller that sends neither gets the route's default window, which
 *   is a change in how *much* comes back but not in its shape.
 * - **The row count travels in the `X-Total-Count` response header.**
 *   A caller that ignores headers is unaffected; one that reads it can
 *   render an honest "showing 100 of 1,480" instead of inferring a total
 *   from the length of the page it happens to be holding.
 *
 * That last point is not a nicety. The panel's overview dashboard read
 * `customers.length` off the unpaginated list and printed it as the
 * customer count, so adding a default window without a real total would
 * have turned an operator's headline figure into "however many rows the
 * page size happened to be" -- a number that looks right and is not.
 * This project has shipped that class of bug before and it is the one
 * thing paging must not reintroduce.
 */

/** A resolved window over a list query. Both fields are always present,
 * so a caller cannot half-apply one. */
export interface ListWindow {
  take: number;
  skip: number;
}

/** A page of rows plus how many there are in total.
 *
 * `total` is the count *before* the window is applied, so it answers
 * "how many are there" rather than "how many did I just get". Services
 * return this; controllers unwrap it with `sendPage`. */
export interface Page<T> {
  items: T[];
  total: number;
}

export interface WindowLimits {
  /** Applied when the caller asks for nothing. Should be large enough
   * that the common case needs no second request and small enough that
   * it is a real bound. */
  defaultTake: number;
  /** The most a caller may ask for, however large a `take` they send.
   * A cap the client cannot raise is the actual bound; the default is
   * only a convenience. */
  maxTake: number;
}

/** Reads `take`/`skip` off a query string and clamps them.
 *
 * Accepts the raw string a `@Query()` hands over, because that is what
 * the existing `GET /client-attempts` route already does and this is
 * meant to be one convention rather than two. Anything unparseable,
 * negative, or zero falls back to the default rather than erroring: a
 * malformed page size is not worth failing an operator's page load over,
 * and the clamp means it cannot be used to ask for the whole table.
 */
export function listWindow(
  params: { take?: string | number | null; skip?: string | number | null },
  limits: WindowLimits,
): ListWindow {
  const requested = toPositiveInt(params.take);
  const skip = toPositiveInt(params.skip) ?? 0;
  return {
    take: Math.min(requested ?? limits.defaultTake, limits.maxTake),
    skip,
  };
}

/** `undefined` for anything that is not a positive integer.
 *
 * `Number.parseInt` is deliberately not used on its own: it reads
 * `"100abc"` as 100 and `"1e9"` as 1, either of which turns a typo into
 * a silently different page. */
function toPositiveInt(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/** The header name, in one place so the panel and the API cannot drift. */
export const TOTAL_COUNT_HEADER = "X-Total-Count";

/** Unwraps a `Page` for a controller: sets the count header and returns
 * the bare array Nest will serialise.
 *
 * Requires `@Res({ passthrough: true })` on the handler, which leaves
 * Nest's normal serialisation, interceptors and exception filters in
 * place -- taking the response object without `passthrough` would make
 * the handler responsible for sending the body itself, which is a much
 * larger change than setting one header is worth.
 */
export function sendPage<T>(res: Response, page: Page<T>): T[] {
  res.setHeader(TOTAL_COUNT_HEADER, String(page.total));
  return page.items;
}

/** Wraps rows that were fetched without a window.
 *
 * For the per-customer routes, where the result is already bounded by
 * the customer it belongs to and a `count` query would be a second round
 * trip to learn something `items.length` already says. */
export function wholeList<T>(items: T[]): Page<T> {
  return { items, total: items.length };
}
