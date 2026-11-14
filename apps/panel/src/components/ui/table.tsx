import * as React from "react";

import { cn } from "@/lib/utils";
import { TableScroll } from "./table-scroll";

/* Two phone layouts, both CSS only (globals.css, under 640px), so a
 * server-rendered table gets them too and nothing measures width in
 * JavaScript. From 640px up neither changes anything.
 *
 * `stack` -- a list of records. Under 640px each row becomes a block:
 * the `cell="primary"` value first (two lines at most, then it shortens),
 * the `cell="status"` badge beside it and the `cell="actions"` button at
 * the top right; then every cell with a `label`, as small "label value"
 * pairs, two to a line (`wide` takes a whole line). `phoneOrder` moves a
 * fact up or down the block without touching the desktop column order.
 * `more` cells are folded behind the row's <TableMoreToggle>; put one in
 * every row that has them. A cell with neither a label nor a `cell` (an
 * empty-state or a row's open detail) takes the whole width. The header
 * row is not shown: no stacked table may rely on it for anything but its
 * column names.
 *
 * `stickyFirst` -- a comparison table whose columns are the point. It
 * keeps its columns and scrolls sideways, but under 640px the first column
 * stays put with a capped width and the cells are tighter, so two or
 * three data columns show beside it.
 *
 * Otherwise, the table scrolls sideways inside its own box (TableScroll),
 * with a hint on the edge that has more; the page never does. A column not
 * worth the width on a phone can be dropped under 640px with `hideOnPhone`
 * -- on its TableHead AND the matching TableCell in every row. */

function Table({
  className,
  stack,
  stickyFirst,
  ...props
}: React.ComponentProps<"table"> & { stack?: boolean; stickyFirst?: boolean }) {
  return (
    <TableScroll>
      <table
        data-slot="table"
        data-stack={stack ? "" : undefined}
        data-sticky-first={stickyFirst ? "" : undefined}
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </TableScroll>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted", className)}
      {...props}
    />
  );
}

function TableHead({ className, hideOnPhone, ...props }: React.ComponentProps<"th"> & { hideOnPhone?: boolean }) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-3 text-left align-middle font-medium text-muted-foreground whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        hideOnPhone && "max-sm:hidden",
        className,
      )}
      {...props}
    />
  );
}

type StackCell = {
  /** The fact's name, shown before its value in a stacked row. */
  label?: string;
  /** Its part in a stacked row's first line. "lead" is a small leading
   * mark (an expand chevron) before the primary value. */
  cell?: "primary" | "status" | "actions" | "lead";
  /** Folded behind the row's "More" in a stacked row. */
  more?: boolean;
  /** Takes a whole line in a stacked row. */
  wide?: boolean;
  /** Position among the facts of a stacked row, 1 first (default 5). */
  phoneOrder?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
};

function TableCell({
  className,
  hideOnPhone,
  label,
  cell,
  more,
  wide,
  phoneOrder,
  ...props
}: React.ComponentProps<"td"> & { hideOnPhone?: boolean } & StackCell) {
  return (
    <td
      data-slot="table-cell"
      data-label={label}
      data-cell={cell}
      data-more={more ? "" : undefined}
      data-wide={wide ? "" : undefined}
      data-order={phoneOrder}
      className={cn("p-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", hideOnPhone && "max-sm:hidden", className)}
      {...props}
    />
  );
}

/** A stacked row's "More": shows the row's `more` cells. Phone only (it
 * is not drawn from 640px up); a checkbox, so it needs no script and
 * works in a server-rendered table. */
function TableMoreToggle({ count }: { count?: number }) {
  return (
    <td data-slot="table-cell" data-cell="more" className="hidden">
      <label className="inline-flex min-h-10 cursor-pointer items-center gap-1 rounded-md pr-2 text-xs font-medium text-muted-foreground select-none hover:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50">
        <input type="checkbox" data-more-toggle="" className="peer sr-only" />
        <span className="peer-checked:hidden">More{count ? ` (${count})` : ""}</span>
        <span className="hidden peer-checked:inline">Less</span>
        <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 transition-transform peer-checked:rotate-180">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </label>
    </td>
  );
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableMoreToggle };
