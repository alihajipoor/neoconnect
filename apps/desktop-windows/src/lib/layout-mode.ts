import { useEffect, useState, type RefObject } from "react";

/** Which of the three layouts the app root is in, by its own width -- the
 * same breakpoints as the container queries in pearl.css. For the few
 * decisions a stylesheet cannot make: where the one location list lives
 * (the panel, or a sheet on a phone). */
export type LayoutMode = "wide" | "medium" | "narrow";

export function layoutFor(width: number): LayoutMode {
  return width >= 900 ? "wide" : width >= 640 ? "medium" : "narrow";
}

export function useLayoutMode(ref: RefObject<HTMLElement | null>, initial: LayoutMode = "wide"): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(initial);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setMode(layoutFor(node.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return mode;
}

/** The same, by the window's own width: the desktop app fills its window. */
export function useWindowLayout(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() => (typeof window === "undefined" ? "wide" : layoutFor(window.innerWidth)));
  useEffect(() => {
    const measure = () => setMode(layoutFor(window.innerWidth));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return mode;
}
