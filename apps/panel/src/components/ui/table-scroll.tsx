"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";

/** The shared table's box: the table scrolls sideways inside it, never the
 * page.
 *
 * Below lg it also says so: a fade and a chevron on whichever edge has
 * more table behind it, shown only while there is. From lg up nothing is
 * drawn, so the desktop look is unchanged. `data-scroll-x` declares this a
 * sideways scroll area to `pnpm check:phone`. */
export function TableScroll({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="relative w-full">
      <div
        ref={ref}
        data-slot="table-container"
        data-scroll-x=""
        className="relative w-full overflow-x-auto max-lg:overscroll-x-contain"
      >
        {children}
      </div>
      {edges.left && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background/80 to-transparent lg:hidden"
        />
      )}
      {edges.right && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-start justify-end bg-gradient-to-l from-background/90 to-transparent pt-2.5 lg:hidden"
        >
          <ChevronRight className="size-4 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
