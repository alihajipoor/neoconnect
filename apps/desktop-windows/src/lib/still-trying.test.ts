import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** When a waiting screen says it is still trying.
 *
 * No DOM here, so React's two hooks are replaced by the smallest honest
 * versions of one component's worth of them, as resume.test.ts does: a
 * state slot per call, an effect that runs after the render when its
 * dependencies changed and cleans up the previous run first, and a
 * render repeated while a state update is pending -- which is what React
 * does with an update made by an effect or a timer. */
const react = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: { deps: unknown[] | undefined; cleanup: void | (() => void) }[] = [];
  const queued: (() => void)[] = [];
  let slot = 0;
  let effect = 0;
  let dirty = false;
  return {
    useState<T>(initial: T): [T, (next: T) => void] {
      const i = slot++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i] as T,
        (next: T) => {
          if (slots[i] === next) return;
          slots[i] = next;
          dirty = true;
        },
      ];
    },
    useEffect(run: () => void | (() => void), deps?: unknown[]) {
      const i = effect++;
      const previous = effects[i];
      const changed = !previous || !deps || !previous.deps || deps.some((d, k) => d !== previous.deps![k]);
      if (!changed) return;
      queued.push(() => {
        if (typeof previous?.cleanup === "function") previous.cleanup();
        effects[i] = { deps, cleanup: run() };
      });
    },
    /** One commit: render, run the effects it queued, and render again
     * for as long as that left an update pending. */
    render<T>(component: () => T): T {
      for (;;) {
        slot = 0;
        effect = 0;
        dirty = false;
        const value = component();
        queued.splice(0).forEach((run) => run());
        if (!dirty) return value;
      }
    },
    reset() {
      slots.length = 0;
      effects.length = 0;
      queued.length = 0;
    },
  };
});
vi.mock("react", () => ({ useState: react.useState, useEffect: react.useEffect }));

const { useStillTrying, STILL_TRYING_AFTER_MS } = await import("./still-trying");

/** The screen, rendered with `waiting`: whether it shows the note. */
const screen = (waiting: boolean) => react.render(() => useStillTrying(waiting));

beforeEach(() => {
  vi.useFakeTimers();
  react.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useStillTrying", () => {
  it("says nothing for the first eight seconds of a wait, then says it", () => {
    expect(screen(true)).toBe(false);
    vi.advanceTimersByTime(STILL_TRYING_AFTER_MS - 1);
    expect(screen(true)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(screen(true)).toBe(true);
  });

  it("is eight seconds, where every request used to give up", () => {
    expect(STILL_TRYING_AFTER_MS).toBe(8_000);
  });

  it("says nothing when nothing is being waited for", () => {
    expect(screen(false)).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(screen(false)).toBe(false);
  });

  it("stops saying it the moment the wait ends", () => {
    screen(true);
    vi.advanceTimersByTime(STILL_TRYING_AFTER_MS);
    expect(screen(true)).toBe(true);
    expect(screen(false)).toBe(false);
  });

  /** A second sign-in after a failed one must not open with the first
   * one's note. */
  it("starts from nothing on the next wait", () => {
    screen(true);
    vi.advanceTimersByTime(STILL_TRYING_AFTER_MS);
    screen(false);
    expect(screen(true)).toBe(false);
    vi.advanceTimersByTime(STILL_TRYING_AFTER_MS - 1);
    expect(screen(true)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(screen(true)).toBe(true);
  });

  /** Two short waits are not one long one. */
  it("does not add up waits that each ended in time", () => {
    screen(true);
    vi.advanceTimersByTime(5_000);
    screen(false);
    vi.advanceTimersByTime(10_000);
    expect(screen(true)).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(screen(true)).toBe(false);
  });
});
