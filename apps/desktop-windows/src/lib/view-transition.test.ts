import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keepOutgoingView, swapView } from "./view-transition";

/** swapView's fallback -- an engine without View Transitions, and every
 * reduced-motion customer -- must cross-fade, never blink to an empty
 * page: the old view is kept, as an inert copy, from before the update
 * until after the new view is drawn (review: "Settings to Per-app routing
 * under reduce, at 0ms only the header, the nav and the map dots").
 *
 * There is no DOM in these tests, so this is the least of one that the
 * function touches: elements with classes, attributes, children and a box. */

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  attributes = new Map<string, string>();
  classes: Set<string>;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  inert = false;
  scrollTop = 0;
  scrollLeft = 0;
  box = { top: 0, left: 0, width: 0, height: 0 };
  constructor(
    className: string,
    public text = "",
  ) {
    this.classes = new Set(className.split(" ").filter(Boolean));
  }
  get classList() {
    return { add: (c: string) => this.classes.add(c), contains: (c: string) => this.classes.has(c) };
  }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const s = part.trim();
      if (s === "*") return true;
      if (s === "[id]") return this.attributes.has("id");
      return s.startsWith(".") && this.classes.has(s.slice(1));
    });
  }
  closest(selector: string): FakeElement | null {
    for (let el: FakeElement | null = this; el; el = el.parentElement) if (el.matches(selector)) return el;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name.startsWith("data-")) delete this.dataset[name.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())];
  }
  getClientRects() {
    return this.box.width > 0 ? [this.box] : [];
  }
  getBoundingClientRect(): { top: number; left: number; width: number; height: number; bottom: number; right: number } {
    // A fixed child is placed against its holder's box (the app root).
    if (this.style.position === "fixed" && this.parentElement) {
      const holder = this.parentElement.getBoundingClientRect();
      const top = holder.top + parseFloat(this.style.top || "0");
      const left = holder.left + parseFloat(this.style.left || "0");
      return { top, left, width: this.box.width, height: this.box.height, bottom: top + this.box.height, right: left + this.box.width };
    }
    return { ...this.box, bottom: this.box.top + this.box.height, right: this.box.left + this.box.width };
  }
  cloneNode(): FakeElement {
    const copy = new FakeElement([...this.classes].join(" "), this.text);
    copy.attributes = new Map(this.attributes);
    copy.dataset = { ...this.dataset };
    copy.box = { ...this.box };
    for (const child of this.children) copy.appendChild(child.cloneNode());
    return copy;
  }
  textOf(): string {
    return [this.text, ...this.children.map((c) => c.textOf())].join("");
  }
}

function fakeDocument(motion?: "reduce") {
  const html = new FakeElement("");
  if (motion) html.dataset.motion = motion;
  const body = html.appendChild(new FakeElement(""));
  const main = body.appendChild(new FakeElement("nx-main"));
  main.box = { top: 40, left: 200, width: 900, height: 700 };
  const page = main.appendChild(new FakeElement("nx-page", "Settings"));
  page.box = { top: 40, left: 200, width: 900, height: 700 };
  page.dataset.enter = "";
  const scroller = page.appendChild(new FakeElement("nx-pscroll"));
  scroller.box = { top: 60, left: 200, width: 900, height: 680 };
  scroller.scrollTop = 240;
  scroller.setAttribute("id", "settings-scroll");
  const doc = {
    documentElement: Object.assign(html, { offsetWidth: 1 }),
    visibilityState: "visible",
    querySelectorAll: (selector: string) => html.querySelectorAll(selector),
    defaultView: null,
  };
  return { doc: doc as unknown as Document, main, page };
}

/** What a frame would show: the views in the layout, and the kept copy. */
function onScreen(main: FakeElement) {
  return {
    live: main.children.filter((c) => !c.classes.has("nx-viewghost")).map((c) => c.textOf()),
    kept: main.children.filter((c) => c.classes.has("nx-viewghost")).map((c) => c.textOf()),
  };
}

describe("swapView without View Transitions: a cross-fade, never a blank frame", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const motion of [undefined, "reduce"] as const) {
    it(`keeps the old view until the new one is drawn${motion ? " (reduced motion)" : ""}`, () => {
      const { doc, main, page } = fakeDocument(motion);
      let duringUpdate: ReturnType<typeof onScreen> | null = null;
      swapView(
        () => {
          // Inside the update the old view is already kept: the copy is in
          // place before anything is taken away.
          duringUpdate = onScreen(main);
          page.remove();
          const next = main.appendChild(new FakeElement("nx-page", "Per-app routing"));
          next.box = { ...page.box };
        },
        "forward",
        doc,
      );
      expect(duringUpdate).toEqual({ live: ["Settings"], kept: ["Settings"] });
      // The first frame after: the new view and the old one fading over it.
      expect(onScreen(main)).toEqual({ live: ["Per-app routing"], kept: ["Settings"] });
      expect(doc.documentElement.dataset.viewIn).toBe("forward");
      // Gone once its exit is over.
      vi.advanceTimersByTime(400);
      expect(onScreen(main)).toEqual({ live: ["Per-app routing"], kept: [] });
    });
  }

  it("the copy is inert, unnamed, out of the reading order, where the view stood and scrolled as it was", () => {
    const { doc, main } = fakeDocument();
    const ghost = keepOutgoingView(doc) as unknown as FakeElement;
    expect(ghost).not.toBeNull();
    expect(ghost.parentElement).toBe(main);
    expect(ghost.inert).toBe(true);
    expect(ghost.attributes.get("aria-hidden")).toBe("true");
    expect(ghost.classes.has("nx-viewghost")).toBe(true);
    // Its entrance is not played again, and no id is doubled.
    expect("enter" in ghost.dataset).toBe(false);
    expect(ghost.querySelectorAll("[id]")).toHaveLength(0);
    // Exactly over the view it copies, whatever box holds it.
    const at = ghost.getBoundingClientRect();
    expect([at.top, at.left, at.width, at.height]).toEqual([40, 200, 900, 700]);
    expect(ghost.children[0].scrollTop).toBe(240);
  });

  it("with no view on screen there is nothing to keep, and the change still happens", () => {
    const { doc, main, page } = fakeDocument();
    page.box = { top: 0, left: 0, width: 0, height: 0 };
    expect(keepOutgoingView(doc)).toBeNull();
    let ran = false;
    swapView(() => (ran = true), "back", doc);
    expect(ran).toBe(true);
    expect(onScreen(main).kept).toEqual([]);
  });
});
