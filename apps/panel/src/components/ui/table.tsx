import * as React from "react";

import { cn } from "@/lib/utils";
import { TableScroll } from "./table-scroll";

/* Phones: the table scrolls sideways inside its own box (TableScroll), with
 * a hint on the edge that has more; the page never does. Cells keep
 * whitespace-nowrap, so a column is as wide as its content needs and no
 * narrower. A column that is not worth the width on a phone can be dropped
 * under sm (640px) with `hideOnPhone` -- on its TableHead AND on the
 * matching TableCell in every row, or the columns misalign. */

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <TableScroll>
      <table
        data-slot="table"
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

function TableCell({ className, hideOnPhone, ...props }: React.ComponentProps<"td"> & { hideOnPhone?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn("p-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", hideOnPhone && "max-sm:hidden", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
