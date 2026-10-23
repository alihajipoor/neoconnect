import { useState, type RefObject } from "react";
import { layoutFor, useLayoutMode, type LayoutMode } from "@shared/lib/layout-mode";

/** Which of the three layouts the phone's main page is in, decided as the
 * stylesheet decides it: by the width of the app root (.nx-app, pearl.css's
 * container queries), not the window's.
 *
 * The two differ on a phone or tablet on its side: #root keeps the notch
 * and the rounded corners clear with side padding (globals.css), so the app
 * root is narrower than the window by both side insets -- about 120px on a
 * large iPhone. Where that crosses a breakpoint, a window-width choice put
 * the script in one layout and the stylesheet in another: the map's stage
 * dropped out of the medium column, or "Try another location" flashed a
 * panel the narrow layout hides and opened nothing.
 *
 * `ref` is the app root (AppShell's `rootRef`). Until it is measured, the
 * width #root leaves its content is the same number, read at once, so the
 * first frame is drawn in the right layout too. */
export function useAppLayout(ref: RefObject<HTMLElement | null>): LayoutMode {
  const [initial] = useState(() => layoutFor(rootContentWidth()));
  return useLayoutMode(ref, initial);
}

/** The width #root gives the screens: its own, less its side padding. The
 * window's width where there is no #root. */
export function rootContentWidth(): number {
  if (typeof window === "undefined") return 0;
  const root = document.getElementById("root");
  if (!root) return window.innerWidth;
  const style = window.getComputedStyle(root);
  return root.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}
