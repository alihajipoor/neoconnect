import { flushSync } from "react-dom";
import { curve, play } from "./motion";

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

/** The views `swapView` changes between: a page, or the main page. */
const VIEWS = ".nx-page, .nx-ov";

/** A copy of the view on screen now, laid exactly where it stands -- inert,
 * hidden from assistive technology, its ids and its own motion stripped
 * (motion.css `.nx-viewghost`) -- so the change can fade it out while the
 * new view comes in, and no frame shows neither. Null when there is no
 * view to keep. */
export function keepOutgoingView(doc: Document): HTMLElement | null {
  const view = Array.from(doc.querySelectorAll<HTMLElement>(VIEWS)).find(
    (el) => el.getClientRects().length > 0 && !el.parentElement?.closest(VIEWS),
  );
  const parent = view?.parentElement;
  if (!view || !parent) return null;
  const box = view.getBoundingClientRect();
  const ghost = view.cloneNode(true) as HTMLElement;
  for (const el of [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("[id]"))]) el.removeAttribute("id");
  ghost.removeAttribute("data-enter");
  ghost.classList.add("nx-viewghost");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.style.position = "fixed";
  ghost.style.top = "0px";
  ghost.style.left = "0px";
  ghost.style.width = `${box.width}px`;
  ghost.style.height = `${box.height}px`;
  ghost.style.margin = "0";
  parent.appendChild(ghost);
  // Measured, not assumed: the app root is a size container, which holds
  // fixed-position children to its own box.
  const at = ghost.getBoundingClientRect();
  ghost.style.top = `${box.top - at.top}px`;
  ghost.style.left = `${box.left - at.left}px`;
  // Scrolled where the view was.
  const from = [view, ...Array.from(view.querySelectorAll<HTMLElement>("*"))];
  const to = [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("*"))];
  from.forEach((el, i) => {
    const copy = to[i];
    if (!copy || (!el.scrollTop && !el.scrollLeft)) return;
    copy.scrollTop = el.scrollTop;
    copy.scrollLeft = el.scrollLeft;
  });
  return ghost;
}

/** Fades the kept view out on the exit curve, then takes it away -- by the
 * animation's end, or by a timer if the engine has no Web Animations. */
function fadeAway(ghost: HTMLElement, doc: Document): void {
  const exit = curve("exit", doc);
  const remove = () => ghost.remove();
  const fade = play(ghost, [{ opacity: 1 }, { opacity: 0 }], { ...exit, fill: "forwards" });
  if (fade) void fade.finished.then(remove, remove);
  setTimeout(remove, exit.duration + 100);
}

/** A change of view inside a screen -- the main page to the Locations page,
 * Settings to one of its pages, Support's list to a conversation, a plan to
 * its payment -- animated like a change of screen: by a view transition
 * where the engine has one, and otherwise by marking <html> for one frame's
 * worth of CSS (`data-view-in`, motion.css), which slides the new view in
 * from the side it logically comes from, or fades it under reduced motion,
 * while a copy of the old view fades out over it (`keepOutgoingView`): a
 * cross-fade, never a blink to an empty page. The update always runs, at
 * once. */
export function swapView(update: () => void, direction: "forward" | "back" = "forward", doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (viewTransitionsAvailable(doc)) {
    withViewTransition(update, direction);
    return;
  }
  if (!doc) {
    update();
    return;
  }
  const root = doc.documentElement;
  // Off first, so a second change inside the window starts its own slide.
  delete root.dataset.viewIn;
  void root.offsetWidth;
  root.dataset.viewIn = direction;
  let ghost: HTMLElement | null = null;
  try {
    ghost = keepOutgoingView(doc);
  } catch {
    ghost = null;
  }
  flushSync(update);
  if (ghost) fadeAway(ghost, doc);
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
