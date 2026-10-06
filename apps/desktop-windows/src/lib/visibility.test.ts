import { afterEach, describe, expect, it } from "vitest";
import { watchBackground } from "./visibility";

/** A document with nothing but what the watcher reads. */
function fakeDocument(state: "visible" | "hidden") {
  const doc = Object.assign(new EventTarget(), { visibilityState: state });
  Object.assign(globalThis, { document: doc });
  return {
    hide() {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    show() {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

afterEach(() => {
  Object.assign(globalThis, { document: undefined });
});

describe("watchBackground", () => {
  it("says no when the app stayed in front", () => {
    fakeDocument("visible");
    expect(watchBackground()()).toBe(false);
  });

  /** The iOS case: backgrounded and brought back before the request
   * finished. That it is visible again at the end changes nothing. */
  it("remembers a trip to the background even after coming back", () => {
    const page = fakeDocument("visible");
    const backgrounded = watchBackground();
    page.hide();
    page.show();
    expect(backgrounded()).toBe(true);
  });

  it("counts starting in the background", () => {
    fakeDocument("hidden");
    expect(watchBackground()()).toBe(true);
  });

  it("stops listening once asked", () => {
    const page = fakeDocument("visible");
    const backgrounded = watchBackground();
    expect(backgrounded()).toBe(false);
    page.hide();
    expect(backgrounded()).toBe(false);
  });

  it("says no where there is no document at all", () => {
    expect(watchBackground()()).toBe(false);
  });
});
