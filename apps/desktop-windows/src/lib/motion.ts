import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** The motion the app does in script, on the same tokens as the stylesheets
 * (theme.css, motion.css; design-system.md section 6):
 *
 *  - what is leaving stays mounted for its exit (`usePresence`), so a
 *    dialog, a menu, a sheet or a banner goes the way it came instead of
 *    vanishing in one frame;
 *  - a view's first entrance in a session (`useFirstView`), staggered in
 *    the stylesheet -- never again on a re-filter, a re-sort or a revisit;
 *  - what opens in a list (a country's protocols, a disclosure) and what
 *    a search or a filter adds and takes away, moved by transform and
 *    faded by opacity alone (`revealBelow`, `flipList`): the layout jumps
 *    once, and what moved is drawn sliding from where it was;
 *  - a sheet let go of with a flick (`dragOutcome`).
 *
 * Every movement here multiplies to nothing under reduced motion: an exit
 * is a short fade, a reveal is a fade, a list re-flows at once. And none of
 * it says anything about the tunnel: what moves is what the customer
 * touched, never a state the app has not verified (calm UI). */

// --- reading the tokens -------------------------------------------------------

export type CurveName = "smooth" | "snappy" | "press" | "morph" | "bouncy" | "exit" | "quick";

export interface Curve {
  duration: number;
  easing: string;
}

/** The tokens' values before reduced motion or a stylesheet says otherwise
 * (theme.css): what script falls back to where it cannot read them. */
export const CURVES: Readonly<Record<CurveName, Curve>> = {
  smooth: { duration: 590, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  snappy: { duration: 540, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  press: { duration: 300, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  morph: { duration: 350, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  bouncy: { duration: 560, easing: "cubic-bezier(0.34, 1.4, 0.64, 1)" },
  exit: { duration: 180, easing: "cubic-bezier(0.4, 0, 1, 1)" },
  quick: { duration: 160, easing: "ease-out" },
};

/** Reduced motion's curves: short ease-outs, nothing that moves. */
export const REDUCED_CURVES: Readonly<Record<CurveName, Curve>> = {
  smooth: { duration: 200, easing: "ease-out" },
  snappy: { duration: 150, easing: "ease-out" },
  press: { duration: 150, easing: "ease-out" },
  morph: { duration: 150, easing: "ease-out" },
  bouncy: { duration: 150, easing: "ease-out" },
  exit: { duration: 150, easing: "ease-out" },
  quick: { duration: 160, easing: "ease-out" },
};

/** The longest exit anything waits for before it unmounts: the exit token
 * with room to spare. A leaving element is inert and hidden from assistive
 * technology from its first frame, so the wait costs nobody anything. */
export const EXIT_MS = 220;

/** Whether motion is reduced right now: the app's switch or the OS (both
 * land on `data-motion`, lib/effects.ts), or the media query before that
 * has run. */
export function motionReduced(doc: Document | undefined = typeof document === "undefined" ? undefined : document): boolean {
  if (!doc) return true;
  if (doc.documentElement.dataset.motion === "reduce") return true;
  try {
    return doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** Parses a CSS time ("540ms", "0.9s"); null when it is not one. */
export function parseTime(value: string): number | null {
  const m = /^\s*(-?[\d.]+)(ms|s)\s*$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "s" ? 1000 : 1);
  return Number.isFinite(n) ? n : null;
}

/** A named curve, read from the tokens on <html> -- so reduced motion, set
 * there, is honoured here without a second switch. */
export function curve(name: CurveName, doc: Document | undefined = typeof document === "undefined" ? undefined : document): Curve {
  const fallback = (motionReduced(doc) ? REDUCED_CURVES : CURVES)[name];
  if (!doc?.defaultView) return fallback;
  try {
    const style = doc.defaultView.getComputedStyle(doc.documentElement);
    const duration = parseTime(style.getPropertyValue(`--dur-${name}`));
    const easing = style.getPropertyValue(`--spring-${name}`).trim();
    return { duration: duration ?? fallback.duration, easing: easing || fallback.easing };
  } catch {
    return fallback;
  }
}

/** `element.animate`, with the curve's easing, or its cubic-bezier fallback
 * on an engine without `linear()` (iOS before 17.2), or nothing at all on
 * one without the Web Animations API. */
export function play(
  element: Element,
  keyframes: Keyframe[],
  timing: Curve & { delay?: number; fill?: FillMode; composite?: CompositeOperation },
  fallbackEasing = "cubic-bezier(0.22, 1, 0.36, 1)",
): Animation | null {
  if (typeof (element as HTMLElement).animate !== "function") return null;
  const options: KeyframeAnimationOptions = {
    duration: timing.duration,
    easing: timing.easing,
    delay: timing.delay ?? 0,
    fill: timing.fill ?? "none",
    composite: timing.composite ?? "replace",
  };
  try {
    return element.animate(keyframes, options);
  } catch {
    try {
      return element.animate(keyframes, { ...options, easing: fallbackEasing });
    } catch {
      return null;
    }
  }
}

// --- leaving ------------------------------------------------------------------

export type Presence = "open" | "closing" | "closed";

/** What an element whose `open` just changed does next: shown at once,
 * kept for its exit, or gone. Pure, for the hook below and its test. */
export function nextPresence(current: Presence, open: boolean): Presence {
  if (open) return "open";
  return current === "closed" ? "closed" : "closing";
}

/** Keeps an element mounted for its exit. `closing` is true for those
 * `ms`: render it with `data-state="closed"`, inert, and the stylesheet
 * plays the exit (motion.css). Reopened mid-exit, it simply stays. */
export function usePresence(open: boolean, ms: number = EXIT_MS): { mounted: boolean; closing: boolean } {
  const [state, setState] = useState<Presence>(open ? "open" : "closed");
  const shown = nextPresence(state, open);
  useEffect(() => {
    if (open) {
      setState("open");
      return;
    }
    if (state === "closed") return;
    setState("closing");
    const timer = setTimeout(() => setState("closed"), motionReduced() ? Math.min(ms, 160) : ms);
    return () => clearTimeout(timer);
    // `state` is written here: reading it once per change of `open` is
    // all the exit needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ms]);
  return { mounted: shown !== "closed", closing: shown === "closing" };
}

/** True while `on`, and on through the exit after it turns off: for what
 * depends on something that leaves the way it came. A banner fading out
 * (`Presence`, components/ui.tsx) still holds its room for its exit, so the
 * room the column gives it -- the sentence's reserve, the map's stage, the
 * compact window's band -- is taken back only once it is gone, in one
 * step, rather than everything moving twice. */
export function useHeldThroughExit(on: boolean, ms: number = EXIT_MS): boolean {
  return usePresence(on, ms).mounted;
}

/** What a closing overlay draws: what it said while it was open. Its
 * props can change the moment it is asked to close -- the switch
 * confirmation's place becomes null, and its title would turn into
 * "Switch to Automatic?" for the exit; Activity's "Sign out {device}?"
 * would lose its device -- and a dialog on its way out must never name a
 * choice nobody made. `Presence` (components/ui.tsx) holds its children
 * the same way. */
export class OpenSnapshot<T> {
  private last: { value: T } | null = null;
  take(open: boolean, value: T): T {
    if (open || this.last === null) this.last = { value };
    return this.last.value;
  }
}

/** `OpenSnapshot` for a component: the value while `open`, and while it
 * closes, the last value it had open. */
export function useOpenSnapshot<T>(open: boolean, value: T): T {
  const snapshot = useRef<OpenSnapshot<T> | null>(null);
  snapshot.current ??= new OpenSnapshot<T>();
  return snapshot.current.take(open, value);
}

// --- a view's first entrance --------------------------------------------------

/** How long a first view's stagger may take to begin, for content that
 * arrives with the first answer -- after that it simply appears. */
export const ENTER_WINDOW_MS = 1_500;

/** The views seen in this session. A view's stagger plays once: never on a
 * re-filter, a re-sort, a re-render or a return to it. */
export class FirstViews {
  private seen = new Set<string>();
  /** Whether `key` has not been shown yet. */
  fresh(key: string): boolean {
    return !this.seen.has(key);
  }
  /** Marks `key` shown; true the first time only. */
  claim(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
  reset(): void {
    this.seen.clear();
  }
}

export const firstViews = new FirstViews();

/** True while the view `key` makes its first entrance of the session: set
 * `data-enter` on its root and the stylesheet staggers what is in it. Null
 * keys never enter (a view with nothing to stagger). Off under reduced
 * motion -- the content is simply there.
 *
 * A key that changes on the same element -- Settings to one of its own
 * pages, drawn by the same Page -- is a new view: decided while rendering,
 * so its first frame already carries the mark. */
export function useFirstView(key: string | null, windowMs: number = ENTER_WINDOW_MS): boolean {
  const fresh = () => key !== null && firstViews.fresh(key) && !motionReduced();
  const [state, setState] = useState(() => ({ key, on: fresh() }));
  let current = state;
  if (state.key !== key) {
    current = { key, on: fresh() };
    setState(current);
  }
  const claimed = useRef<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const off = () => setState((s) => (s.key === key && s.on ? { key, on: false } : s));
    if (claimed.current !== key) {
      if (!firstViews.claim(key)) {
        off();
        return;
      }
      claimed.current = key;
    }
    const timer = setTimeout(off, windowMs);
    return () => clearTimeout(timer);
  }, [key, windowMs]);
  return current.on;
}

/** What staggers in a view's first entrance: its header, its cards and its
 * groups, each a block; and the rows of a list inside one (motion.css). */
export const STAGGER_BLOCKS = ".nx-phead, .nx-pcard, .nx-group, .nx-auth-card, [data-stagger]";

/** Numbers a view's blocks in the order they are drawn (`--i`), outermost
 * only: a card inside a card moves with it. The stylesheet caps the delay at
 * the eighth (design-system.md 6.3). */
export function numberStagger(root: ParentNode): number {
  let i = 0;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(STAGGER_BLOCKS))) {
    const outer = el.parentElement?.closest(STAGGER_BLOCKS) ?? null;
    if (outer !== null && outer !== root && root.contains(outer)) continue;
    el.style.setProperty("--i", String(i++));
  }
  return i;
}

/** `useFirstView` and the numbering together, for a view's root element. */
export function useStagger<T extends HTMLElement>(key: string | null): { ref: RefObject<T | null>; enter: boolean } {
  const ref = useRef<T | null>(null);
  const enter = useFirstView(key);
  useLayoutEffect(() => {
    if (enter && ref.current) numberStagger(ref.current);
  });
  return { ref, enter };
}

// --- opening in place ---------------------------------------------------------

/** The keyframes of something opening (or closing) in a list: the opened
 * part slides out from under the row above it while everything after it
 * moves down by the same amount, clipped by the opened part's own box --
 * transform alone, so the layout changes once and nothing re-lays out per
 * frame. Under reduced motion only the opened part fades. */
export function revealFrames(height: number, opening: boolean, reduced: boolean): { panel: Keyframe[]; after: Keyframe[] | null } {
  if (reduced || !(height > 0)) {
    return { panel: opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], after: null };
  }
  const up = `translateY(${-Math.round(height)}px)`;
  const panel = [
    { transform: up, opacity: 0.4 },
    { transform: "translateY(0)", opacity: 1 },
  ];
  const after = [{ transform: up }, { transform: "translateY(0)" }];
  return opening ? { panel, after } : { panel: [...panel].reverse(), after: [...after].reverse() };
}

/** Everything drawn after `el` up to `boundary` -- its later siblings, and
 * its ancestors' later siblings -- which moves when `el` grows. Only what
 * is on screen, so a long list costs a handful of animations. */
export function followersOf(el: Element, boundary: Element, viewBottom = Infinity): HTMLElement[] {
  const out: HTMLElement[] = [];
  let node: Element | null = el;
  while (node && node !== boundary) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      if (next instanceof HTMLElement && next.getBoundingClientRect().top <= viewBottom) out.push(next);
    }
    node = node.parentElement;
  }
  return out;
}

/** Plays an opening (after the opened part is laid out) or a closing
 * (before it is taken away). A closing calls `done` when it ends, which
 * must take the part away synchronously (`flushSync`): the held end frames
 * are let go straight after, in the same frame, so nothing jumps. */
export function revealBelow(panel: HTMLElement, opening: boolean, options: { boundary?: Element | null; done?: () => void } = {}): void {
  const reduced = motionReduced();
  const inner = (panel.firstElementChild as HTMLElement | null) ?? panel;
  const height = panel.getBoundingClientRect().height;
  const frames = revealFrames(height, opening, reduced);
  const timing = curve(opening ? "snappy" : "morph");
  const animations: (Animation | null)[] = [play(inner, frames.panel, { ...timing, fill: opening ? "none" : "forwards" })];
  if (frames.after) {
    const boundary = options.boundary ?? panel.closest(".nx-loclist, .nx-pscroll, .nx-hero, .nx-sheet-body") ?? document.body;
    const viewBottom = boundary.getBoundingClientRect().bottom + height;
    for (const follower of followersOf(panel, boundary, viewBottom)) {
      animations.push(play(follower, frames.after, { ...timing, fill: opening ? "none" : "forwards" }));
    }
  }
  if (!options.done) return;
  const done = options.done;
  const running = animations.filter((a): a is Animation => a !== null);
  if (running.length === 0) {
    done();
    return;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
    running.forEach((a) => a.cancel());
  };
  void Promise.all(running.map((a) => a.finished)).then(finish, finish);
  setTimeout(finish, timing.duration + 120);
}

// --- a list that re-flows -----------------------------------------------------

/** A row's key: `data-row`, or `data-flip` for what sits between rows. */
function rowKey(el: HTMLElement): string | undefined {
  return el.dataset.row ?? (el.dataset.flip ? `flip:${el.dataset.flip}` : undefined);
}

/** A row before a change: where it was, and a copy of it to fade if it
 * goes. */
export interface RowSnapshot {
  box: DOMRect;
  copy: HTMLElement;
}

/** Where each keyed row of a list is, before a change. A row not drawn (in
 * a closed country) is not anywhere. */
export function snapshotRows(container: Element, selector = "[data-row]"): Map<string, RowSnapshot> {
  const out = new Map<string, RowSnapshot>();
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(selector))) {
    const key = rowKey(el);
    const box = el.getBoundingClientRect();
    if (key && (box.width > 0 || box.height > 0)) out.set(key, { box, copy: el });
  }
  return out;
}

/** A copy of a row that left, for its fade: inert, unnamed, unreachable. */
function ghostOf(row: HTMLElement): HTMLElement {
  const copy = row.cloneNode(true) as HTMLElement;
  for (const el of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>("[id]"))]) el.removeAttribute("id");
  copy.removeAttribute("data-row");
  copy.removeAttribute("data-flip");
  copy.setAttribute("tabindex", "-1");
  copy.style.width = "100%";
  copy.style.margin = "0";
  return copy;
}

/** After a search or a filter changed a list: the rows that stayed slide
 * from where they were, the rows that arrived fade in, and the rows that
 * left fade where they stood (a copy, inert, over the list). Off under
 * reduced motion, where the list simply changes. */
export function flipList(container: HTMLElement, before: Map<string, RowSnapshot>, selector = "[data-row]"): void {
  if (motionReduced()) return;
  const move = curve("snappy");
  const fade = curve("quick");
  const exit = curve("exit");
  const now = new Map<string, HTMLElement>();
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(selector))) {
    const key = rowKey(el);
    if (key) now.set(key, el);
  }
  let entered = 0;
  for (const [key, el] of now) {
    const was = before.get(key)?.box;
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    if (!was) {
      play(el, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }], {
        ...fade,
        duration: fade.duration + 60,
        delay: Math.min(entered++, 6) * 18,
        fill: "backwards",
      });
      continue;
    }
    const dy = was.top - box.top;
    if (Math.abs(dy) < 1) continue;
    play(el, [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], move);
  }
  // The rows that left: a copy where each stood, fading out.
  const host = container.getBoundingClientRect();
  for (const [key, { box: was, copy }] of before) {
    if (now.has(key) || was.bottom < host.top || was.top > host.bottom) continue;
    const ghost = document.createElement("div");
    ghost.className = "nx-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    ghost.style.cssText = `top:${was.top - host.top + container.scrollTop}px;left:${was.left - host.left + container.scrollLeft}px;width:${was.width}px;height:${was.height}px`;
    ghost.appendChild(ghostOf(copy));
    container.appendChild(ghost);
    // Gone quickly, from the start (an ease-out), so the rows sliding up
    // into its place are not read through it.
    const a = play(ghost, [{ opacity: 0.85 }, { opacity: 0 }], { ...fade, duration: Math.min(fade.duration, exit.duration), fill: "forwards" });
    const remove = () => ghost.remove();
    if (a) void a.finished.then(remove, remove);
    else remove();
    setTimeout(remove, exit.duration + 100);
  }
}

// --- a sheet let go of --------------------------------------------------------

/** Past this far, or flung faster than `FLING_PX_PER_MS`, a dragged sheet
 * closes; otherwise it springs back (design-system.md 6.1). */
export const DISMISS_PX = 120;
export const FLING_PX_PER_MS = 0.6;

export function dragOutcome(dy: number, ms: number): "close" | "stay" {
  const speed = dy / Math.max(1, ms);
  return dy > DISMISS_PX || speed > FLING_PX_PER_MS ? "close" : "stay";
}

/** The scrim under a sheet dragged `dy` of its `height`: it thins as the
 * sheet goes, so letting go mid-way never flashes. */
export function scrimFor(dy: number, height: number): number {
  if (!(height > 0)) return 1;
  return Math.max(0, Math.min(1, 1 - dy / height));
}

// --- a pill whose label changed length ----------------------------------------

/** The keyframes that grow a pill from its old width to its new one by
 * scale, its inline start held (where its label starts): the label inside
 * is counter-scaled so it never stretches. Null when nothing visible would
 * change, or under reduced motion. */
export function widthMorph(from: number, to: number, reduced: boolean): { box: Keyframe[]; content: Keyframe[] } | null {
  if (reduced || !(from > 0) || !(to > 0) || Math.abs(from - to) < 1) return null;
  const k = from / to;
  return {
    box: [{ transform: `scaleX(${k.toFixed(4)})` }, { transform: "scaleX(1)" }],
    content: [{ transform: `scaleX(${(1 / k).toFixed(4)})` }, { transform: "scaleX(1)" }],
  };
}
