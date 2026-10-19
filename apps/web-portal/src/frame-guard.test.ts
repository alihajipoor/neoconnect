import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OWN_TAB_LINK, isFramed, showOwnTabLink } from "./frame-guard";

describe("inside another site's frame", () => {
  it("is told apart from a page of its own", () => {
    const self = {};
    expect(isFramed({ top: self, self })).toBe(false);
    expect(isFramed({ top: {}, self })).toBe(true);
    const throwing = {
      self,
      get top(): unknown {
        throw new Error("blocked");
      },
    };
    expect(isFramed(throwing)).toBe(true);
  });

  it("shows only a link to itself, opened at the top level, in both languages", () => {
    type Node = { tag: string; children: Node[]; [k: string]: unknown };
    const make = (tag: string): Node => ({
      tag,
      children: [],
      append(...c: Node[]) {
        this.children.push(...c);
      },
    });
    const root = { replaced: [] as Node[], replaceChildren(...c: Node[]) { this.replaced = c; } };
    const doc = { createElement: make } as unknown as Document;
    showOwnTabLink(root as unknown as Element, "https://neoxify.net/account/?plan=1", doc);
    expect(root.replaced).toHaveLength(1);
    const [box] = root.replaced;
    expect(box.className).toBe("pa-noscript");
    const links = box.children.map((p) => p.children[0]);
    expect(links.map((a) => a.tag)).toEqual(["a", "a"]);
    for (const a of links) {
      expect(a.href).toBe("https://neoxify.net/account/?plan=1");
      expect(a.target).toBe("_top");
    }
    expect(links.map((a) => a.textContent)).toEqual([OWN_TAB_LINK.en, OWN_TAB_LINK.fa]);
    expect(box.children[1].lang).toBe("fa");
    expect(box.children[1].dir).toBe("rtl");
  });

  it("is checked before anything of the app is drawn", () => {
    const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const guard = main.indexOf("if (isFramed())");
    expect(guard).toBeGreaterThan(-1);
    expect(main.indexOf("createRoot")).toBeGreaterThan(guard);
    expect(main.slice(guard, main.indexOf("} else {", guard))).not.toContain("createRoot");
  });

  it("styles its link with the inline first-paint CSS, which needs no script", () => {
    const scene = readFileSync(new URL("./auth/scene.css", import.meta.url), "utf8");
    expect(scene).toMatch(/\.pa-noscript a \{/);
  });
});
