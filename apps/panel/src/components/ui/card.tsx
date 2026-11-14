import * as React from "react";

import { cn } from "@/lib/utils";

/** A page's own padding or gap (p-0 on a card that holds a table, p-5,
 * gap-4) is what it asked for at every width, so the card's tighter phone
 * defaults step aside for it. Only unprefixed utilities count: a page's
 * own `md:p-8` says nothing about phones. */
const OWN_PADDING = /(^|\s)!?(p|py|pt|pb)-/;
const OWN_GAP = /(^|\s)!?gap(-y)?-/;

function Card({ className, ...props }: React.ComponentProps<"div">) {
  const own = className ?? "";
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        !OWN_GAP.test(own) && "max-sm:gap-5",
        !OWN_PADDING.test(own) && "max-sm:py-5",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-col gap-1.5 px-6 max-sm:px-4", className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-title" className={cn("leading-none font-semibold", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6 max-sm:px-4", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex items-center px-6 max-sm:px-4", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
