// The stylesheet for a Windows web component without container queries
// (old-engine-css.mjs), checked on a real build of the app: every layout
// rule has its twin, and an engine with container queries gets exactly the
// stylesheet it got before the step.

import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import { HAS_COSMETIC, HAS_FALLBACKS, syncHasAttributes, supportsHas } from "../src/lib/old-engine-has";
import { hasArguments, hasCq, NO_CONTAINER, NO_HAS, NO_LH, readContainer, toViewport, transformCss } from "./old-engine-css.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const squash = (s) => s.replace(/\s+/g, "");
const OURS = new Set([NO_CONTAINER, NO_HAS, NO_LH].map(squash));
const isOurs = (n) => n?.type === "atrule" && n.name === "supports" && OURS.has(squash(n.params));
const inside = (node, test) => {
  for (let p = node.parent; p; p = p.parent) if (test(p)) return true;
  return false;
};

/** The app's CSS as it ships, and as it was before this step. */
let shipped = "";
let before = "";

beforeAll(async () => {
  // As a release builds it: Tailwind optimizes (and writes its colour
  // fallbacks) only when NODE_ENV is production, and vitest sets "test".
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const output = await build({
    root,
    configFile: path.join(root, "vite.config.ts"),
    logLevel: "silent",
    build: { write: false },
    plugins: [
      {
        // A plain plugin's generateBundle runs before the step's ("post").
        name: "capture-before",
        generateBundle(_, bundle) {
          const css = Object.values(bundle).find((f) => f.type === "asset" && f.fileName.endsWith(".css"));
          // Less the marker Vite takes off once every plugin has run.
          before = String(css.source).replace(/\n?\/\*\$vite\$:\d+\*\//g, "\n");
        },
      },
    ],
  }).finally(() => {
    process.env.NODE_ENV = env;
  });
  const outputs = Array.isArray(output) ? output : [output];
  const css = outputs.flatMap((o) => o.output).find((f) => f.type === "asset" && f.fileName.endsWith(".css"));
  shipped = typeof css.source === "string" ? css.source : new TextDecoder().decode(css.source);
}, 180_000);

describe("the shipped stylesheet", () => {
  it("is this step's output on the build's own CSS, with nothing it could not handle", () => {
    expect(before).toContain("@container app");
    const again = transformCss(before, { has: HAS_FALLBACKS, cosmetic: HAS_COSMETIC });
    expect(again.problems).toEqual([]);
    // So the step is wired into vite.config.ts, and ran last.
    expect(shipped).toBe(again.css);
  });

  it("is the stylesheet from before for any engine with container queries", () => {
    const parsed = postcss.parse(shipped);
    parsed.walkAtRules("supports", (at) => {
      if (isOurs(at) && !inside(at, isOurs)) at.remove();
    });
    expect(parsed.toString()).toBe(before);
  });

  it("gives every @container rule a media twin right after it", () => {
    const parsed = postcss.parse(shipped);
    let app = 0;
    parsed.walkAtRules("container", (at) => {
      if (inside(at, isOurs)) return;
      const twin = at.next();
      expect(isOurs(twin) && squash(twin.params) === squash(NO_CONTAINER), `no twin after @container ${at.params}`).toBe(true);
      const { name, condition } = readContainer(at.params);
      if (name !== "app") return;
      app++;
      expect(twin.nodes.length).toBe(1);
      const media = twin.nodes[0];
      expect(media.name).toBe("media");
      expect(squash(media.params)).toBe(squash(condition));
      // The same rules, in the same order.
      const selectors = (n) => n.nodes.map((c) => (c.type === "rule" ? c.selector : `@${c.name} ${c.params}`));
      expect(selectors(media)).toEqual(selectors(at));
      // And no cq unit left: an old engine would drop the declaration.
      media.walkDecls((d) => expect(hasCq(d.value), `${d.prop}: ${d.value}`).toBe(false));
    });
    // 29 on 2026-11-13; fewer would mean the walk missed some.
    expect(app).toBeGreaterThanOrEqual(25);
  });

  it("follows every rule with a cq unit, outside @container, with a copy in window units", () => {
    const parsed = postcss.parse(shipped);
    let seen = 0;
    parsed.walkRules((rule) => {
      if (inside(rule, isOurs) || inside(rule, (p) => p.type === "atrule" && (p.name === "container" || /keyframes$/.test(p.name)))) return;
      if (!rule.nodes.some((d) => d.type === "decl" && hasCq(d.value))) return;
      seen++;
      let next = rule.next();
      // A `:has()` or `lh` copy may sit between.
      while (isOurs(next) && squash(next.params) !== squash(NO_CONTAINER)) next = next.next();
      expect(isOurs(next), `no copy after ${rule.selector}`).toBe(true);
      const copy = next.nodes[0];
      expect(copy.selector).toBe(rule.selector);
      copy.walkDecls((d) => expect(hasCq(d.value)).toBe(false));
    });
    // The headline, the column's gap, the timer row, the sign-in pages.
    expect(seen).toBeGreaterThanOrEqual(10);
  });

  it("leaves no :has() that is neither stood in for nor known to be cosmetic", () => {
    const listed = [...HAS_FALLBACKS.map((f) => f.child), ...HAS_COSMETIC].map(squash);
    const parsed = postcss.parse(shipped);
    let stood = 0;
    parsed.walkRules((rule) => {
      if (inside(rule, isOurs)) return;
      for (const { arg } of hasArguments(rule.selector)) expect(listed, `:has(${arg}) in ${rule.selector}`).toContain(squash(arg));
      if (HAS_FALLBACKS.some((f) => rule.selector.includes(`:has(${f.child})`))) {
        stood++;
        expect(isOurs(rule.next()) && squash(rule.next().params) === squash(NO_HAS), rule.selector).toBe(true);
      }
    });
    expect(stood).toBeGreaterThan(30);
  });

  it("has a plain colour before every color-mix(), which Chromium 99 to 110 lacks", () => {
    // Tailwind's own minifier writes these: each color-mix() sits in
    // `@supports (color: color-mix(...))` after a declaration of the same
    // property with a plain colour, so text and borders never fall back to
    // nothing on an old engine. A color-mix() written outside that would.
    const parsed = postcss.parse(shipped);
    let mixes = 0;
    parsed.walkDecls((d) => {
      if (!d.value.includes("color-mix(")) return;
      mixes++;
      const guard = inside(d, (p) => p.type === "atrule" && p.name === "supports" && p.params.includes("color-mix("));
      expect(guard, `${d.parent.selector} { ${d.prop}: ${d.value} }`).toBe(true);
    });
    expect(mixes).toBeGreaterThan(0);
  });
});

describe("transformCss", () => {
  const has = HAS_FALLBACKS;
  const cosmetic = HAS_COSMETIC;

  it("twins a new app rule and converts its cq units to the window's", () => {
    const { css, problems } = transformCss("@layer c{@container app (min-width:500px) and (max-height:600px){.x{width:10cqw;--y:clamp(1px,2cqh,3px)}}}", { has, cosmetic });
    expect(problems).toEqual([]);
    expect(css).toContain("@supports not (container-type:size){@media (min-width:500px) and (max-height:600px){.x{width:10vw;--y:clamp(1px,2vh,3px)}}}");
  });

  it("copies a rule whose declaration has a cq unit and a var(), after it", () => {
    const { css } = transformCss(".t{font:700 clamp(34px,min(4.2cqw,7cqh),68px)/.98 var(--f);color:red}", {});
    expect(css).toBe(".t{font:700 clamp(34px,min(4.2cqw,7cqh),68px)/.98 var(--f);color:red}@supports not (container-type:size){.t{font:700 clamp(34px,min(4.2vw,7vh),68px)/.98 var(--f);color:red}}");
  });

  it("measures the phone column's units on its line, in the phone layout only", () => {
    const { css } = transformCss("@container app (max-width:639.98px){.nx-hero-copy>.nx-tag{font-size:clamp(24px,min(10.4cqw,6.2cqh),46px)}}", {});
    expect(css).toContain("min(calc(10.4vw - 4.16px),calc(6.2vh - 7.192px))");
    const wide = transformCss("@container app (min-width:900px){.nx-hero-copy{padding-block:4.6cqh}}", {});
    expect(wide.css).toContain("padding-block:4.6vh");
  });

  it("places an inner container's condition on the window", () => {
    const { css, problems } = transformCss("@container lpanel (max-width:299.98px){.r{display:none}}", {});
    expect(problems).toEqual([]);
    expect(css).toContain("@media (min-width:900px) and (max-width:1249.917px){.r{display:none}}");
    expect(css).toContain("@media (min-width:640px) and (max-width:899.98px) and (max-width:699.716px){.r{display:none}}");
  });

  it("reports what it cannot mirror", () => {
    expect(transformCss("@container other (min-width:5px){.a{color:red}}", {}).problems[0]).toMatch(/no model/);
    expect(transformCss("@container app (orientation:portrait){.a{color:red}}", {}).problems[0]).toMatch(/only min\/max/);
    expect(transformCss(".a:has(.b){color:red}", { has, cosmetic }).problems[0]).toMatch(/no fallback/);
    expect(transformCss(".a{container:sidebar/inline-size}", {}).problems[0]).toMatch(/no model/);
  });

  it("stands in for a listed :has() with its attribute", () => {
    const { css } = transformCss(".nx-auth:has(.nx-msg) .nx-or{display:none}", { has, cosmetic });
    expect(css).toBe(".nx-auth:has(.nx-msg) .nx-or{display:none}@supports not selector(:has(a)){.nx-auth[data-nx-has-msg] .nx-or{display:none}}");
  });

  it("puts back the em the minifier took from an lh unit", () => {
    const { css } = transformCss(".h{min-height:3lh;line-height:1.8}.s{min-height:calc(2lh - 4px)}", {});
    expect(css).toContain("@supports not (width:1lh){.h{min-height:5.4em;line-height:1.8}}");
    expect(css).toContain("@supports not (width:1lh){.s{min-height:calc(2.9em - 4px)}}");
  });

  it("writes cqmin and cqmax as min() and max() of both", () => {
    expect(toViewport("3cqmin 2cqmax")).toBe("min(3vw, 3vh) max(2vw, 2vh)");
  });
});

describe("the :has() stand-ins at run time", () => {
  it("are kept only on an engine without :has()", () => {
    expect(supportsHas({ supports: () => true })).toBe(true);
    expect(supportsHas({ supports: () => false })).toBe(false);
    expect(supportsHas({ supports: () => { throw new Error("no"); } })).toBe(false);
    expect(supportsHas(undefined)).toBe(false);
  });

  it("set and clear each attribute by whether the host has the child", () => {
    const attrs = new Map();
    const host = (has) => ({
      querySelector: (sel) => (has && sel === ":scope .nx-msg" ? {} : null),
      hasAttribute: (a) => attrs.has(`${has}${a}`),
      setAttribute: (a) => attrs.set(`${has}${a}`, ""),
      removeAttribute: (a) => attrs.delete(`${has}${a}`),
    });
    const withMsg = host(true);
    const without = host(false);
    attrs.set("falsedata-nx-has-msg", "");
    const root = { querySelectorAll: (sel) => (sel === ".nx-auth" ? [withMsg, without] : []) };
    syncHasAttributes(root, HAS_FALLBACKS);
    expect(attrs.has("truedata-nx-has-msg")).toBe(true);
    expect(attrs.has("falsedata-nx-has-msg")).toBe(false);
  });
});
