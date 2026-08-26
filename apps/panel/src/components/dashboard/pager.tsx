import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/** The window a list page is showing, read off its own searchParams.
 *
 * Clamped here as well as in the API because the two numbers are used
 * twice on the way through: once to build the request and once to render
 * the pager's range. If `?take=abc` fell back to NaN on the panel side,
 * the request would still come back correctly bounded by the server's
 * own clamp and the footer would read "Showing NaN-NaN of 1,480".
 *
 * `maxTake` mirrors the 500 the backend routes cap at (see
 * `apps/backend/src/common/pagination.ts`), so the pager's arithmetic
 * matches the page the server will actually return rather than the one
 * that was asked for.
 */
export function pageWindow(
  params: { take?: string; skip?: string },
  defaultTake = 100,
  maxTake = 500,
): { take: number; skip: number } {
  return {
    take: Math.min(positiveInt(params.take) ?? defaultTake, maxTake),
    skip: positiveInt(params.skip) ?? 0,
  };
}

/** Deliberately not `parseInt`, which reads "100abc" as 100 and "1e9" as
 * 1 -- the same reasoning as the backend's own parser, kept identical so
 * a URL cannot mean two different windows. */
function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/** The footer under a bounded list: which rows these are, out of how many
 * there are, and how to get to the next lot.
 *
 * Plain links and no client state, so this stays usable on a page that is
 * a Server Component and keeps working with JavaScript off. `total` must
 * come from `apiFetchList`'s `X-Total-Count` reading and never from
 * `items.length`, which is the page size wearing a total's clothes.
 *
 * `params` carries the rest of the page's query string -- a search term,
 * a status filter -- because a Next link paged from `/invoices?status=PAID`
 * has to still be filtered to PAID when it lands.
 */
export function Pager({
  total,
  take,
  skip,
  basePath,
  params = {},
}: {
  total: number;
  take: number;
  skip: number;
  basePath: string;
  params?: Record<string, string | undefined>;
}) {
  // A single page that starts at the beginning has nothing to say: the
  // rows are all of them and there is nowhere to go. Past the first page
  // it always renders, even when the last page is short, because "back"
  // is the only way out.
  if (total <= take && skip === 0) return null;

  const first = total === 0 ? 0 : skip + 1;
  const last = Math.min(skip + take, total);
  const hasPrev = skip > 0;
  const hasNext = skip + take < total;

  function href(nextSkip: number) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) query.set(key, value);
    }
    query.set("take", String(take));
    if (nextSkip > 0) query.set("skip", String(nextSkip));
    return `${basePath}?${query.toString()}`;
  }

  const step = cn(buttonVariants({ variant: "outline", size: "sm" }));
  const spent = cn(step, "pointer-events-none opacity-40");

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground tabular-nums">
        Showing {first.toLocaleString()}&ndash;{last.toLocaleString()} of {total.toLocaleString()}
      </p>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link href={href(Math.max(skip - take, 0))} className={step} rel="prev">
            <ChevronLeft /> Previous
          </Link>
        ) : (
          <span className={spent} aria-hidden="true">
            <ChevronLeft /> Previous
          </span>
        )}
        {hasNext ? (
          <Link href={href(skip + take)} className={step} rel="next">
            Next <ChevronRight />
          </Link>
        ) : (
          <span className={spent} aria-hidden="true">
            Next <ChevronRight />
          </span>
        )}
      </div>
    </div>
  );
}
