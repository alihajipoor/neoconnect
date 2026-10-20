import { flushSync } from "react-dom";

/** A state change animated with the View Transitions API where the engine
 * has it, and applied at once where it does not.
 *
 * WebView2 has the API; WKWebView before iOS 18 and old Android WebViews
 * do not, and get the caller's own CSS fallback. Never under reduced
 * motion, and never in a hidden window, where the snapshot would wait on a
 * frame that does not come.
 *
 * Guarded as the prototype was: if the update has not run within
 * `GUARD_MS` of asking -- a throttled or hidden page -- the transition is
 * skipped and the update runs anyway. An animation must never be the reason
 * a screen did not change. Whether glass captured inside a snapshot flashes
 * or freezes in WebView2 is not verified yet (design-system.md, 6.2). */

export const GUARD_MS = 450;

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { skipTransition?: () => void; finished?: Promise<void> };
};

/** Whether a view transition would run now. */
export function viewTransitionsAvailable(doc: Document | undefined = typeof document === "undefined" ? undefined : document): boolean {
  if (!doc) return false;
  const vt = (doc as TransitionDocument).startViewTransition;
  return typeof vt === "function" && doc.documentElement.dataset.motion !== "reduce" && doc.visibilityState !== "hidden";
}

/** How long the fallback's mark stays on <html>: the snappy spring, with
 * room. */
export const VIEW_IN_MS = 600;

/** A change of view inside a screen -- the main page to the Locations page,
 * Settings to one of its pages, Support's list to a conversation, a plan to
 * its payment -- animated like a change of screen: by a view transition
 * where the engine has one, and otherwise by marking <html> for one frame's
 * worth of CSS (`data-view-in`, motion.css), which slides the new view in
 * from the side it logically comes from, or fades it under reduced motion.
 * The update always runs, at once. */
export function swapView(update: () => void, direction: "forward" | "back" = "forward"): void {
  if (viewTransitionsAvailable()) {
    withViewTransition(update, direction);
    return;
  }
  if (typeof document === "undefined") {
    update();
    return;
  }
  const root = document.documentElement;
  // Off first, so a second change inside the window starts its own slide.
  delete root.dataset.viewIn;
  void root.offsetWidth;
  root.dataset.viewIn = direction;
  flushSync(update);
  setTimeout(() => {
    if (root.dataset.viewIn === direction) delete root.dataset.viewIn;
  }, VIEW_IN_MS);
}

/** Runs `update` inside a view transition, or at once. `direction` is
 * which way the new view arrives from ("forward" toward the inline end). */
export function withViewTransition(update: () => void, direction: "forward" | "back" = "forward"): void {
  if (!viewTransitionsAvailable()) {
    update();
    return;
  }
  const doc = document as TransitionDocument;
  const root = doc.documentElement;
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    flushSync(update);
  };
  root.dataset.vtDir = direction;
  let transition: ReturnType<NonNullable<TransitionDocument["startViewTransition"]>> | undefined;
  const guard = setTimeout(() => {
    if (ran) return;
    transition?.skipTransition?.();
    run();
  }, GUARD_MS);
  try {
    transition = doc.startViewTransition!.call(doc, () => {
      clearTimeout(guard);
      run();
    });
    void transition.finished?.finally(() => {
      if (root.dataset.vtDir === direction) delete root.dataset.vtDir;
    });
  } catch {
    clearTimeout(guard);
    run();
  }
}
