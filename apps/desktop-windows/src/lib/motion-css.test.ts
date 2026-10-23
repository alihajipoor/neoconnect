import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** The motion pass's rules, read from every stylesheet the apps load
 * (motion.css's header): tokens for every duration and curve, transform and
 * opacity for everything that moves, no loop at rest, and a reduced-motion
 * path for every movement. */

const FILES = {
  theme: "../theme.css",
  pearl: "../pearl.css",
  pages: "../pages.css",
  motion: "../motion.css",
  phone: "../../../mobile/src/phone.css",
} as const;

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const sheets = Object.fromEntries(Object.entries(FILES).map(([name, rel]) => [name, strip(read(rel))])) as Record<keyof typeof FILES, string>;
const all = Object.values(sheets).join("\n");

/** Every `@keyframes name { ... }` and the properties it sets. */
function keyframes(css: string): { name: string; body: string; props: string[] }[] {
  const out: { name: string; body: string; props: string[] }[] = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    const body = css.slice(re.lastIndex, i - 1);
    const props = [...new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]))];
    out.push({ name: m[1], body, props });
  }
  return out;
}

/** Every declaration of `prop` (a shorthand or a longhand), with the
 * selector it sits under. */
function declarations(css: string, prop: RegExp): { selector: string; value: string }[] {
  const out: { selector: string; value: string }[] = [];
  // Keyframe bodies are not rules about elements.
  const plain = css.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const re = /([^{};]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain))) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    for (const d of m[2].split(";")) {
      const at = d.indexOf(":");
      if (at < 0) continue;
      const name = d.slice(0, at).trim();
      if (prop.test(name)) out.push({ selector, value: d.slice(at + 1).trim().replace(/\s+/g, " ") });
    }
  }
  return out;
}

/** Splits a comma list at the top level (not inside parentheses). */
function topLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** What may never be transitioned or animated: anything that lays out. */
const LAYOUT =
  /^(?:all|width|height|min-width|max-width|min-height|max-height|inline-size|block-size|top|right|bottom|left|inset(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|padding(?:-[a-z-]+)?|grid-template-(?:rows|columns)|grid-(?:row|column)(?:-[a-z]+)?|flex(?:-[a-z]+)?|gap|row-gap|column-gap|font-size|line-height|letter-spacing|border(?:-[a-z]+)?-width|border-width)$/;

/** The infinite loops the app has, and why each is allowed: busy only, or
 * the location lights (design-system.md 5.4). Each must stop under reduced
 * motion, by the rule named. */
const LOOPS: Record<string, { why: string; reduce: RegExp }> = {
  "nx-spin": { why: "a spinner, only while something is under way", reduce: /\[data-motion="reduce"\][^{]*(?:\.nx-spin|\.nx-dot\.spin|\.nx-spinning|\.nx-subline\[data-now\])/ },
  "nx-prog": { why: "the pill's progress line, only while busy", reduce: /\[data-motion="reduce"\][^{]*\.nx-btn \.prog::after/ },
  "nx-msweep": { why: "the mark's sweep, only while busy", reduce: /\[data-motion="reduce"\][^{]*\.nx-mark \.sweep/ },
  "nx-shimmer": { why: "a skeleton's sheen, only while it is on screen", reduce: /\[data-motion="reduce"\][^{]*\.nx-skel::after/ },
  "nx-twinkle": { why: "the location lights", reduce: /\[data-motion="reduce"\] \.nx-lamp::after/ },
  "nx-twcore": { why: "the location lights", reduce: /\[data-motion="reduce"\] \.nx-lamp::before/ },
  "nx-breathe": { why: "the connected light", reduce: /\[data-motion="reduce"\] \.nx-lamp::after/ },
  "ping-ring": { why: "the first-generation orb's ring, only while connected on it", reduce: /\.animate-ping-ring/ },
  "spin-slow": { why: "the first-generation orb's dial, only while busy", reduce: /\.animate-spin-slow/ },
  shimmer: { why: "the first-generation shimmer utility", reduce: /\.animate-shimmer::after/ },
  breathe: { why: "the first-generation breathe utility", reduce: /\.animate-breathe/ },
};

describe("the stylesheets are read", () => {
  it("finds the keyframes, transitions and animations it checks", () => {
    expect(keyframes(all).length).toBeGreaterThan(30);
    expect(declarations(all, /^transition$/).length).toBeGreaterThan(40);
    expect(declarations(all, /^animation$/).length).toBeGreaterThan(40);
  });
});

describe("every movement is transform and opacity", () => {
  it("no keyframes animate anything but transform and opacity (the focus ring's offset excepted)", () => {
    for (const k of keyframes(all)) {
      const extra = k.props.filter((p) => p !== "transform" && p !== "opacity");
      if (k.name === "nx-focus") expect(extra).toEqual(["outline-offset"]);
      else expect(extra, `@keyframes ${k.name}`).toEqual([]);
    }
  });

  it("no transition lists a property that lays out", () => {
    for (const d of declarations(all, /^transition(?:-property)?$/)) {
      if (d.value === "none") continue;
      for (const part of topLevel(d.value)) {
        const prop = part.split(" ")[0];
        expect(LAYOUT.test(prop), `${d.selector} { transition: ${d.value} }`).toBe(false);
      }
    }
  });

  it("the old layout transitions are gone: the accordion, the disclosure, the switch, the meters, the pill", () => {
    expect(all).not.toMatch(/grid-template-rows\s+var\(--dur/);
    expect(all).not.toMatch(/transition:[^;]*\bwidth\b/);
    expect(sheets.pearl).not.toMatch(/\.nx-sw:not\(\[disabled\]\):active::before\s*\{\s*width/);
  });
});

describe("every duration and curve is a token", () => {
  it("each transition takes a --dur-* and a --spring-*", () => {
    for (const d of declarations(all, /^transition$/)) {
      if (d.value === "none" || /^none\b/.test(d.value)) continue;
      for (const part of topLevel(d.value)) {
        expect(part, `${d.selector}`).toMatch(/var\(--dur-[a-z-]+\)/);
        expect(part, `${d.selector}`).toMatch(/var\(--spring-[a-z-]+\)/);
      }
    }
    for (const d of declarations(all, /^transition-duration$/)) expect(d.value, d.selector).toMatch(/^var\(--dur-[a-z-]+\)$/);
  });

  it("each finite animation takes a --dur-* and a --spring-*, and each loop a --loop-*", () => {
    for (const d of declarations(all, /^animation$/)) {
      if (d.value === "none" || d.value.startsWith("none")) continue;
      if (/\binfinite\b|\s\d+$/.test(d.value)) {
        expect(d.value, d.selector).toMatch(/var\(--(?:loop-[a-z]+|tw, var\(--loop-twinkle\))\)/);
      } else {
        expect(d.value, d.selector).toMatch(/var\(--dur-[a-z-]+\)/);
        expect(d.value, d.selector).toMatch(/var\(--spring-[a-z-]+\)/);
      }
    }
    for (const d of declarations(all, /^animation-duration$/)) expect(d.value, d.selector).toMatch(/^var\(--dur-[a-z-]+\)$/);
    for (const d of declarations(all, /^animation-timing-function$/)) expect(d.value, d.selector).toMatch(/^var\(--spring-[a-z-]+\)$/);
  });

  it("each delay is the stagger's", () => {
    for (const d of declarations(all, /^animation-delay$/)) expect(d.value, d.selector).toMatch(/var\(--stagger(?:-fine)?\)/);
  });

  it("the tokens are the design system's springs, with linear() where the engine has it", () => {
    expect(sheets.theme).toMatch(/--dur-smooth: 590ms;/);
    expect(sheets.theme).toMatch(/--dur-snappy: 540ms;/);
    expect(sheets.theme).toMatch(/--dur-press: 300ms;/);
    expect(sheets.theme).toMatch(/--dur-morph: 350ms;/);
    expect(sheets.theme).toMatch(/--dur-bouncy: 560ms;/);
    expect(sheets.theme).toMatch(/@supports \(transition-timing-function: linear\(0, 1\)\)/);
    for (const spring of ["smooth", "snappy", "bouncy", "press", "morph"]) {
      expect(sheets.theme).toMatch(new RegExp(`--spring-${spring}: linear\\(0, `));
    }
  });
});

describe("nothing loops at rest", () => {
  it("every infinite animation is one of the known loops, and each stops under reduced motion", () => {
    const used = new Set<string>();
    for (const d of declarations(all, /^animation$/)) {
      if (!/\binfinite\b/.test(d.value)) continue;
      const name = d.value.split(" ")[0];
      used.add(name);
      expect(Object.keys(LOOPS), `${d.selector} loops ${name}`).toContain(name);
    }
    for (const name of used) expect(all, `${name}: ${LOOPS[name].why}`).toMatch(LOOPS[name].reduce);
  });

  it("the loops run only under a busy or loading selector, or on a light", () => {
    for (const d of declarations(all, /^animation$/)) {
      if (!/\binfinite\b/.test(d.value)) continue;
      expect(d.selector).toMatch(/busy|\.prog|spin|\[data-now\]|nx-skel|nx-lamp|animate-|\.nx-dot\.spin|nx-spinning/);
    }
  });
});

describe("reduced motion", () => {
  /** A reduced-motion block's body. */
  const block = (css: string, head: RegExp) => {
    const at = css.search(head);
    expect(at).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", at);
    let depth = 1;
    let i = open + 1;
    for (; depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    return css.slice(open + 1, i - 1);
  };

  it("the app's switch and the OS both stop translation, the stagger and every spring", () => {
    for (const body of [block(sheets.theme, /:root\[data-motion="reduce"\] \{/), block(sheets.theme, /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{/)]) {
      expect(body).toMatch(/--move: 0;/);
      expect(body).toMatch(/--stagger: 0ms;/);
      expect(body).toMatch(/--stagger-fine: 0ms;/);
      for (const spring of ["smooth", "snappy", "bouncy", "press", "morph", "exit"]) expect(body).toMatch(new RegExp(`--spring-${spring}: ease-out;`));
    }
  });

  it("every finite keyframe that travels multiplies by --move, so it becomes a fade", () => {
    // Loops are stopped outright (above); the bouncy check has its own
    // reduced rule; a skeleton's sheen and the busy line are loops.
    const EXEMPT = new Set(["nx-spin", "spin-slow", "nx-prog", "nx-msweep", "nx-shimmer", "shimmer", "nx-twinkle", "nx-breathe", "breathe", "ping-ring", "nx-float", "nx-ground", "nx-popc"]);
    for (const k of keyframes(all)) {
      if (EXEMPT.has(k.name) || !k.props.includes("transform")) continue;
      expect(k.body, `@keyframes ${k.name}`).toMatch(/var\(--move\)/);
    }
  });

  it("the press scale, the stretch and the focus settle are off", () => {
    expect(sheets.motion).toMatch(/:root\[data-motion="reduce"\] :is\([^)]*\.nx-ibtn[^)]*\):active \{\s*transform: none;/);
    expect(sheets.motion).toMatch(/:root\[data-motion="reduce"\] \.nx-sw:not\(\[disabled\]\):active::before \{\s*transform: none;/);
    expect(sheets.motion).toMatch(/:root\[data-motion="reduce"\] :focus-visible \{\s*animation: none;/);
    expect(sheets.pearl).toMatch(/:root\[data-motion="reduce"\] \.nx-btn:active \{\s*transform: none;/);
  });

  it("view transitions turn off, leaving the stylesheet's fade", () => {
    expect(sheets.pearl).toMatch(/:root\[data-motion="reduce"\]::view-transition-group\(\*\)/);
    const vt = read("./view-transition.ts");
    expect(vt).toContain('doc.documentElement.dataset.motion !== "reduce"');
  });
});

describe("motion.css changes no layout of its own", () => {
  it("never sets a position, a size or a display on the shell's frame", () => {
    // A `position: relative` on the phone's nav once took it out of its
    // docked place and cost the main page 106px (the phone fit check).
    for (const d of declarations(sheets.motion, /^(?:position|width|height|display|inset|top|bottom|left|right|margin|padding)$/)) {
      expect(d.selector, `${d.selector} { ${d.value} }`).not.toMatch(/\.nx-(?:mnav|mtabs|side|nav|mhead|main|view|shell|hero|ov|tray|panel)(?:$|,|\s*\{)/);
    }
  });
});

describe("every selector the motion rules use is one the engine keeps", () => {
  it("no pseudo-element inside :is() or :where(): it is invalid, and drops the whole rule", () => {
    // `:root[data-motion="reduce"] :is(.nx-skel::after, .nx-spinning)` was
    // dropped whole, so the skeletons' sheen kept looping under reduced
    // motion while a test that read the text passed.
    for (const [name, css] of Object.entries(sheets)) {
      const re = /:(?:is|where)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(css))) {
        let depth = 1;
        let i = re.lastIndex;
        for (; i < css.length && depth > 0; i++) {
          if (css[i] === "(") depth++;
          else if (css[i] === ")") depth--;
        }
        expect(css.slice(re.lastIndex, i - 1), `${name}: ${css.slice(m.index, i)}`).not.toMatch(/::/);
      }
    }
  });

  it("the skeletons' sheen stops under reduced motion by a rule of its own", () => {
    expect(sheets.motion).toMatch(/:root\[data-motion="reduce"\] \.nx-skel::after \{\s*animation: none;\s*opacity: 0;\s*\}/);
    expect(sheets.motion).toMatch(/:root\[data-motion="reduce"\] \.nx-spinning \{\s*animation: none;\s*\}/);
  });
});

describe("nothing is see-through while it moves", () => {
  it("a sheet is opaque while it slides, and fades only under reduced motion, where it does not move", () => {
    const sheetIn = keyframes(sheets.pearl).find((k) => k.name === "nx-sheet-in");
    expect(sheetIn?.body).toMatch(/opacity: calc\(1 - 0\.6 \* \(1 - var\(--move\)\)\);/);
    const sheetOut = keyframes(sheets.motion).find((k) => k.name === "nx-sheet-out");
    expect(sheetOut?.body).toMatch(/opacity: var\(--move\);/);
  });

  it("a sheet over the main page is denser glass, so the cobalt button does not tint the rows over it", () => {
    expect(sheets.pearl).toMatch(/\.nx-glass\.strong\.nx-sheet \{\s*background: linear-gradient\(var\(--sheen-a\), var\(--sheen-b\)\), var\(--glass-sheet, var\(--glass-strong\)\);/);
    expect(sheets.theme).toMatch(/--glass-sheet: rgba\(255, 255, 255, 0\.86\);/);
    expect(sheets.theme.match(/--glass-sheet: rgba\(22, 27, 39, 0\.84\);/g)?.length).toBe(2);
  });

  it("a change of view never dips: the new view is opaque by the time the old one is gone", () => {
    expect(sheets.pearl).toMatch(
      /::view-transition-new\(nxview\) \{\s*animation:\s*nx-vt-in-fade var\(--dur-exit\) var\(--spring-quick\) both,\s*nx-vt-in-slide var\(--dur-snappy\) var\(--spring-snappy\) both;/,
    );
    expect(sheets.pearl).toMatch(/::view-transition-old\(nxview\) \{\s*animation: nx-vt-out var\(--dur-exit\) var\(--spring-exit\) both;/);
    expect(sheets.pearl).toMatch(/:root\[data-vt-dir="back"\]::view-transition-new\(nxview\) \{\s*animation-name: nx-vt-in-fade, nx-vt-in-slide-back;/);
  });

  it("swapView's fallback keeps the old view as a still copy while it fades", () => {
    expect(sheets.motion).toMatch(/\.nx-viewghost,\s*\.nx-viewghost \*,\s*\.nx-viewghost \*::before,\s*\.nx-viewghost \*::after \{\s*animation: none !important;\s*transition: none !important;/);
  });
});

describe("every control gives way under the finger", () => {
  /** The controls a customer presses, the phone's location card among them
   * (it opens the locations sheet: the most pressed control on that page). */
  const PRESSED = [
    ".nx-ibtn",
    ".nx-chipbtn",
    ".nx-nav button",
    ".nx-mnav button",
    ".nx-dtoggle",
    ".nx-sumline",
    "button.nx-li",
    ".nx-row",
    ".nx-pick-row",
    ".nx-perapp-row",
    ".nx-hloc",
  ];
  /** Whether `control` is one of the selectors a rule lists. */
  const lists = (selector: string, control: string) =>
    selector
      .replace(/^[^(]*:is\(/, "")
      .split(",")
      .map((s) => s.replace(/\)[^)]*$/, "").trim())
      .includes(control);

  it("each has the press spring, a press of its own, a focus that settles, and stands still under reduced motion", () => {
    const transitions = declarations(sheets.motion, /^transition$/);
    const transforms = declarations(sheets.motion, /^transform$/);
    const focus = declarations(sheets.motion, /^animation$/).filter((d) => d.selector.includes(":focus-visible"));
    for (const control of PRESSED) {
      expect(transitions.some((d) => lists(d.selector, control) && /transform var\(--dur-press\) var\(--spring-press\)/.test(d.value)), `${control}: transition`).toBe(true);
      expect(
        transforms.some((d) => lists(d.selector, control) && d.selector.includes(":active") && !d.selector.includes("reduce") && /^scale\(/.test(d.value)),
        `${control}: :active`,
      ).toBe(true);
      expect(focus.some((d) => lists(d.selector, control)), `${control}: :focus-visible`).toBe(true);
      expect(
        transforms.some((d) => lists(d.selector, control) && d.selector.includes('data-motion="reduce"') && d.selector.includes(":active") && d.value === "none"),
        `${control}: reduced motion`,
      ).toBe(true);
    }
  });
});

describe("motion.css is loaded everywhere the screens are drawn, last", () => {
  it("by the desktop, the phone and the web portal's signed-in pages", () => {
    const desktop = read("../globals.css");
    expect(desktop.indexOf('@import "./motion.css";')).toBeGreaterThan(desktop.indexOf('@import "./pages.css";'));
    const phone = read("../../../mobile/src/globals.css");
    expect(phone.indexOf('@import "../../desktop-windows/src/motion.css";')).toBeGreaterThan(phone.indexOf('@import "../../desktop-windows/src/pages.css";'));
    const portal = read("../../../web-portal/src/signed-in.css");
    expect(portal.indexOf('@import "../../desktop-windows/src/motion.css";')).toBeGreaterThan(portal.indexOf('@import "../../desktop-windows/src/pages.css";'));
  });

  it("its rules sit in the components layer with the ones they refine", () => {
    expect(read("../motion.css")).toMatch(/^@layer components \{/m);
  });
});

describe("no component moves its layout in script or in a class", () => {
  const tsx = [
    "../components/ui.tsx",
    "../components/overlay.tsx",
    "../components/ConnectOrb.tsx",
    "../components/CustomModeCard.tsx",
    "../components/LocationList.tsx",
    "../components/main/SessionTray.tsx",
    "../screens/Activity.tsx",
    "../screens/Referrals.tsx",
  ].map((rel) => [rel, read(rel)] as const);

  it("no Tailwind transition of a layout property, and no width set to animate", () => {
    for (const [rel, src] of tsx) {
      expect(src, rel).not.toMatch(/transition-\[(?:width|height|inset[^\]]*|left|right|top|bottom|margin[^\]]*|padding[^\]]*)\]/);
      expect(src, rel).not.toMatch(/transition-all/);
      expect(src, rel).not.toMatch(/\.style\.width = /);
    }
  });

  it("the meters are drawn as a fraction, by scale", () => {
    expect(read("../components/main/SessionTray.tsx")).toContain('"--f": Math.max(0.015, Math.min(1, plan.meter.fraction))');
    expect(read("../screens/Activity.tsx")).toContain('"--f": Math.min(1, used / cap)');
    expect(read("../screens/Referrals.tsx")).toContain('"--f": percent / 100');
    expect(sheets.motion).toMatch(/:is\(\.nx-meter, \.nx-bar\) > i \{[^}]*transform: scaleX\(var\(--f, 0\)\);/);
  });
});
