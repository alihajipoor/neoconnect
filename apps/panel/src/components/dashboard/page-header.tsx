import { cn } from "@/lib/utils";

/** A page's title row: the heading and its line on the left, the page's
 * buttons on the right.
 *
 * From sm (640px) up this is exactly the `flex items-center
 * justify-between` row every page wrote by hand. On a phone the buttons go
 * under the heading and wrap, instead of pushing the row past the screen.
 *
 * `title` and `description` are rendered as given (an h1 and a muted
 * line); pass `children` instead of `title` for a heading that needs more
 * than text, and `className` to change the outer gap. */
export function PageHeader({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="min-w-0">
        {title !== undefined && <h1 className="text-xl font-semibold break-words">{title}</h1>}
        {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
