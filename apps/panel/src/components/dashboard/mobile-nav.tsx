"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, XIcon } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import type { AdminRole } from "@/lib/session";

/** The side menu as a drawer, below lg (1024px).
 *
 * A Radix Dialog, so focus stays inside while it is open, Escape and a tap
 * on the dimmed page close it, and focus returns to the button after. It
 * closes once a page is chosen, and again whenever the path changes. The
 * list itself is SidebarNav, the same one the desktop side menu renders,
 * so the two can never offer different pages. The button is hidden from
 * lg up, where the side menu is always there. */
export function MobileNav({ role, email }: { role: AdminRole; email: string }) {
  const pathname = usePathname();
  // Open only on the path it was opened on: any navigation, the browser's
  // back button included, closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (next: boolean) => setOpenOn(next ? pathname : null);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger
        aria-label="Open menu"
        className="-ml-2 flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none lg:hidden"
      >
        <Menu className="size-5" />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 lg:hidden" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-white/8 bg-card pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-xl duration-200 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left lg:hidden"
        >
          <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/8 pr-2 pl-4">
            <Logo />
            <DialogPrimitive.Close
              aria-label="Close menu"
              className="flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <XIcon className="size-5" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <SidebarNav role={role} inDrawer onNavigate={() => setOpen(false)} />
          </div>
          {/* The address the header has no room for on a phone. */}
          <p className="shrink-0 truncate border-t border-white/8 px-4 py-3 text-xs text-muted-foreground" title={email}>
            {email}
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
