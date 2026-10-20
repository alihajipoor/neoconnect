import { afterAll, describe, expect, it, vi } from "vitest";

// A stored "dark" theme, as the portal's Settings writes it
// (lib/effects.ts), in the Map that stands in for localStorage under node.
vi.hoisted(() => {
  const map = new Map<string, string>([["nx.effects.theme", "dark"]]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
});

import { effects } from "@shared/lib/effects";
import { keepThemeOffSignIn, setSurface } from "./surface";

/** <html>, as far as the effects and the surface touch it. */
const html = () => ({ dataset: {} as DOMStringMap }) as HTMLElement;

describe("the theme chosen in Settings", () => {
  afterAll(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it("is the shared screens' alone: off the sign-in, back with the screens behind it", () => {
    const root = html();
    setSurface("auth", root);
    expect(root.dataset.surface).toBe("auth");
    expect(root.dataset.theme).toBeUndefined();
    setSurface("app", root);
    expect(root.dataset.theme).toBe("dark");
    setSurface("auth", root);
    expect(root.dataset.theme).toBeUndefined();
  });

  it("stays off the sign-in when the effects apply themselves again", () => {
    // The page opens on the sign-in (index.html).
    const root = html();
    root.dataset.surface = "auth";
    (globalThis as { document?: unknown }).document = { documentElement: root };
    const stop = keepThemeOffSignIn();
    expect(root.dataset.theme).toBeUndefined();
    // What startEffects() does on a system change, and Settings on a pick.
    effects.setTheme("dark");
    expect(root.dataset.theme).toBeUndefined();
    setSurface("app");
    expect(root.dataset.theme).toBe("dark");
    effects.setTheme("light");
    expect(root.dataset.theme).toBe("light");
    effects.setTheme("system");
    expect(root.dataset.theme).toBeUndefined();
    stop();
  });
});
