// The stylesheet for a Windows web component without container queries.
//
// Every layout of the app (wide, medium, phone) is written as
// `@container app (...)` rules, with sizes in cq units. WebView2 / Chromium
// 99 to 104 has neither: it drops every one of those rules, and every
// declaration that uses a cq unit, and draws the bare base rules -- one
// narrow column, no sidebar, no server panel, the mode switch twice, a 14px
// headline (a customer's screen, reproduced on Chromium 100 and 104 on
// 2026-11-12). This build step gives such an engine the same layouts in
// rules it understands, and nothing to any other engine:
//
// - Each `@container app (C)` rule gets a twin right after it,
//   `@supports not (container-type: size) { @media (C) { ... } }`. The app
//   root (`.nx-app`) is the container, and it fills the window: its width
//   and height are the viewport's (the title strip is drawn over it, not
//   beside it), so the media twin is exact. One known difference: a page
//   drawn outside the shell (`.nx-solo`) is an inline-size container, where
//   a height condition never matches; its media twin does match.
// - Each declaration with a cq unit gets the same declaration in viewport
//   units: in a twin, in place; elsewhere, in a copy of its rule right
//   after it, inside the same `@supports not`. A copy of the rule rather
//   than a declaration before it, because a declaration with `var()` in it
//   (the headline's `font`) or a custom property (`--side`) is kept by an
//   old engine at parse time and only fails later, so a fallback before it
//   would never be used.
// - The inner containers (`INNER` below: the phone layout's column, the
//   locations panel, the tray's speed, address and plan) are not the
//   window, so they are mirrored by a measured approximation: each one's
//   width or height as a straight line of the window's in the layout it
//   lives in, measured on Chromium 105 and 157 in the preview. Their
//   `@container` rules get media twins on that line, and cq units measured
//   against them use it too. Approximate by construction; see each model.
// - `:has()` (also Chromium 105) is handled by src/lib/old-engine-has.ts:
//   the rules it lists get a copy with an attribute in place of `:has()`,
//   inside `@supports not selector(:has(a))`.
// - The `lh` unit (Chromium 109) had fallbacks in the source, which the
//   minifier drops as overridden; they are put back in em, inside
//   `@supports not (width:1lh)`. Without them 99 to 108 lost the reserved
//   rows that keep the connect button where it is (33px higher at 1150x780).
//
// Engines from 109 on answer "no" to all three `@supports not` conditions
// (105 to 108 to the first two), so
// for them the stylesheet is the one Tailwind and Vite made, rule for rule:
// old-engine-css.test.ts removes every block added here from a real build
// and compares what is left with the stylesheet before this step.
//
// It runs on the final CSS of a build (`generateBundle`), after Tailwind
// and the minifier, so a rule added anywhere -- by hand or by Tailwind --
// is covered, and nothing later can merge or reorder what it adds. What it
// cannot handle (a container it has no model for, a condition it cannot
// read, a `:has()` in neither list) is reported as a build warning and
// fails old-engine-css.test.ts.

import postcss from "postcss";
// The `:has()` table is the app's own, shared with the code that keeps the
// stand-in attributes (imported from here, not from vite.config.ts, so the
// config's TypeScript project does not take in a file of the app's).
import { HAS_COSMETIC, HAS_FALLBACKS } from "../src/lib/old-engine-has.ts";

/** The condition the old-engine rules are kept behind. */
export const NO_CONTAINER = "not (container-type:size)";
export const NO_HAS = "not selector(:has(a))";
export const NO_LH = "not (width:1lh)";
const LH = /(?:^|[^\w.-])(?:\d+\.?\d*|\.\d+)lh\b/;
const LH_ALL = /(?<![\w.-])(\d+\.?\d*|\.\d+)lh\b/g;

const CQ = /(-?(?:\d+\.?\d*|\.\d+))(cqw|cqh|cqi|cqb|cqmin|cqmax)\b/g;
export const hasCq = (value) => /(?:\d|\.)(?:cqw|cqh|cqi|cqb|cqmin|cqmax)\b/.test(value);

/** The inner containers, each as straight lines of the window's size in
 * the layout it is drawn in: width = a * window width + b, and the same
 * for the height. `scope` names the rules outside its own `@container`
 * rules whose cq units are measured against it.
 *
 * Measured 2026-11-13 in the preview (`preview.html?fill`), not connected
 * and connected with a live speed, on Chromium 105 and 157 at the window
 * sizes in the comments; the line is fitted where it decides something. */
export const INNER = {
  // The phone layout's column (`.nx-hero`, pearl.css): the window less the
  // 20px sides, and less the header, the docked nav and their gaps
  // (360x640 -> 320x524, 390x844 -> 350x728, 600x700 -> 560x584). With a
  // phone's safe areas it is shorter by them; the desktop has none.
  col: {
    scope: /\.nx-(?:hero-copy|tag|bigrow)\b/,
    models: [{ media: "(max-width:639.98px)", w: { a: 1, b: -40 }, h: { a: 1, b: -116 } }],
  },
  // The locations panel (`.nx-panel`). Wide: `--panel` is
  // clamp(268px, 24vw, 340px), and its only rule asks for less than 300px,
  // which is 24vw below 1250px exactly. Medium: 700 -> 300, 800 -> 346,
  // 899 -> 391.
  lpanel: {
    scope: null,
    models: [
      { media: "(min-width:900px)", w: { a: 0.24, b: 0 } },
      { media: "(min-width:640px) and (max-width:899.98px)", w: { a: 0.4573, b: -20 } },
    ],
  },
  // The tray's speed section, wide layout only (medium and phone show the
  // speed as a card of 312px and more): 1100 -> 157, 1150 -> 166,
  // 1180 -> 172. Fitted at its one threshold, 166px, so the sparkline
  // steps aside below a window of about 1150px, as it does today.
  nxspeed: {
    scope: null,
    models: [{ media: "(min-width:900px)", w: { a: 0.18, b: -41 } }],
  },
  // The tray's address and plan, wide layout only, with the speed section
  // beside them -- the narrower of the two trays (without it they are
  // about 25% wider): 900 -> 168, 1150 -> 221, 1920 -> 393. Their figure,
  // clamp(14px, 11.5cqi, 21px), reaches its 21px from about 190px; without
  // a speed section an old engine draws it a little smaller than a new
  // one at the narrowest windows, never larger.
  nxip: { scope: /\.nx-tip\b/, models: [{ media: "(min-width:900px)", w: { a: 0.22, b: -29 } }] },
  nxplan: { scope: /\.nx-tplan\b/, models: [{ media: "(min-width:900px)", w: { a: 0.22, b: -29 } }] },
};

const round = (n) => Math.round(n * 1000) / 1000;

/** A media condition read into ranges, or null when it is not one of
 * `(min-|max-)(width|height): <n>px` joined by `and`. */
export function readCondition(text) {
  const range = { minW: -Infinity, maxW: Infinity, minH: -Infinity, maxH: Infinity };
  const parts = text.trim().split(/\s+and\s+/i);
  for (const part of parts) {
    const m = /^\(\s*(min|max)-(width|height)\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/i.exec(part.trim());
    if (!m) return null;
    const key = `${m[1].toLowerCase()}${m[2].toLowerCase() === "width" ? "W" : "H"}`;
    const n = Number(m[3]);
    range[key] = key.startsWith("min") ? Math.max(range[key], n) : Math.min(range[key], n);
  }
  return range;
}

/** `@container` parameters: its name, if any, and its condition. */
export function readContainer(params) {
  const m = /^\s*([A-Za-z_-][\w-]*)?\s*(\(.*)$/s.exec(params);
  if (!m) return null;
  return { name: m[1] ?? null, condition: m[2].trim() };
}

/** Whether every window inside `inner` is inside `outer` too. */
function within(inner, outer) {
  return inner.minW >= outer.minW && inner.maxW <= outer.maxW && inner.minH >= outer.minH && inner.maxH <= outer.maxH;
}

/** A length of the container, in window units: `k` percent of a line. */
function onLine(k, line, unit) {
  const a = round(k * line.a);
  const b = round((k * line.b) / 100);
  if (b === 0) return `${a}${unit}`;
  return `calc(${a}${unit} ${b < 0 ? "-" : "+"} ${Math.abs(b)}px)`;
}

/** `value` with its cq units in window units: the window itself when
 * `model` is null (the app root), else the model's lines. */
export function toViewport(value, model = null) {
  const w = model?.w ?? { a: 1, b: 0 };
  // A container queried only for its width has a height of the window's
  // (cqh falls back to the small viewport); every model here is one.
  const h = model?.h ?? { a: 1, b: 0 };
  return value.replace(CQ, (_, n, unit) => {
    const k = Number(n);
    switch (unit) {
      case "cqw":
      case "cqi":
        return onLine(k, w, "vw");
      case "cqh":
      case "cqb":
        return onLine(k, h, "vh");
      case "cqmin":
        return `min(${onLine(k, w, "vw")}, ${onLine(k, h, "vh")})`;
      default:
        return `max(${onLine(k, w, "vw")}, ${onLine(k, h, "vh")})`;
    }
  });
}

/** A media condition, in window units, for an inner container's condition
 * under one of its models; null when it cannot be read. */
function innerCondition(condition, model) {
  const range = readCondition(condition);
  if (!range) return null;
  const parts = [model.media];
  const add = (feature, n, line) => {
    if (!Number.isFinite(n)) return;
    if (!line || line.a <= 0) return false;
    parts.push(`(${feature}:${round((n - line.b) / line.a)}px)`);
    return true;
  };
  const h = model.h ?? { a: 1, b: 0 };
  for (const [key, feature, line] of [
    ["minW", "min-width", model.w],
    ["maxW", "max-width", model.w],
    ["minH", "min-height", h],
    ["maxH", "max-height", h],
  ]) {
    if (add(feature, range[key], line) === false) return null;
  }
  return parts.join(" and ");
}

/** The selectors inside `:has()` in `selector`, as written. */
export function hasArguments(selector) {
  const out = [];
  let at = selector.indexOf(":has(");
  while (at !== -1) {
    let depth = 0;
    let quote = null;
    let i = at + 4;
    for (; i < selector.length; i++) {
      const c = selector[i];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    out.push({ start: at, end: i + 1, arg: selector.slice(at + 5, i) });
    at = selector.indexOf(":has(", i + 1);
  }
  return out;
}

const squash = (s) => s.replace(/\s+/g, "");

/** `selector` with each `:has()` it has a fallback for replaced by that
 * fallback's attribute; null when any `:has()` in it has none. */
function withoutHas(selector, fallbacks) {
  const found = hasArguments(selector);
  let out = "";
  let from = 0;
  for (const { start, end, arg } of found) {
    const fb = fallbacks.find((f) => squash(f.child) === squash(arg));
    if (!fb) return null;
    out += selector.slice(from, start) + `[${fb.attr}]`;
    from = end;
  }
  return out + selector.slice(from);
}

function inside(node, test) {
  for (let p = node.parent; p; p = p.parent) if (test(p)) return p;
  return null;
}
const isContainer = (n) => n.type === "atrule" && n.name === "container";
const isKeyframes = (n) => n.type === "atrule" && /keyframes$/.test(n.name);
const OURS = new Set([NO_CONTAINER, NO_HAS, NO_LH].map((c) => c.replace(/\s+/g, "")));
const isOurs = (n) => n.type === "atrule" && n.name === "supports" && OURS.has(squash(n.params));

/** Written as tightly as the minified file around it. */
function tight(node) {
  node.walk((n) => {
    n.raws = n.type === "decl" ? { before: "", between: ":" } : { before: "", between: "", after: "", afterName: n.type === "atrule" ? " " : undefined, semicolon: false };
  });
  node.raws = { before: "", between: "", after: "", afterName: node.type === "atrule" ? " " : undefined, semicolon: false };
  return node;
}

/**
 * The old-engine rules added to `css`, and what could not be given them.
 *
 * @param {string} css
 * @param {{ has?: readonly {host: string, child: string, attr: string}[], cosmetic?: readonly string[], inner?: typeof INNER }} options
 * @returns {{ css: string, problems: string[], twins: number, fallbacks: number, hasCopies: number }}
 */
export function transformCss(css, options = {}) {
  const fallbacks = options.has ?? HAS_FALLBACKS;
  const cosmetic = (options.cosmetic ?? HAS_COSMETIC).map(squash);
  const inner = options.inner ?? INNER;
  const problems = [];
  const root = postcss.parse(css);
  let twins = 0;
  let cqCopies = 0;
  let hasCopies = 0;
  let lhCopies = 0;

  // 1. `:has()`: a copy with the attribute, behind its own condition.
  const hasRules = [];
  root.walkRules((rule) => {
    if (rule.selector.includes(":has(")) hasRules.push(rule);
  });
  for (const rule of hasRules) {
    const keep = [];
    for (const selector of rule.selectors) {
      const args = hasArguments(selector);
      if (args.length === 0) continue;
      const replaced = withoutHas(selector, fallbacks);
      if (replaced) keep.push(replaced);
      else if (!args.every(({ arg }) => cosmetic.includes(squash(arg)))) {
        problems.push(`:has() with no fallback and not listed as cosmetic: ${selector}`);
      }
    }
    if (keep.length === 0) continue;
    const copy = rule.clone({ selector: keep.join(",") });
    const wrap = postcss.atRule({ name: "supports", params: NO_HAS });
    wrap.append(copy);
    rule.after(tight(wrap));
    hasCopies++;
  }

  // 2. cq units outside `@container`: a copy of the rule in window units.
  const cqRules = [];
  root.walkRules((rule) => {
    if (inside(rule, isContainer) || inside(rule, isKeyframes) || inside(rule, isOurs)) return;
    if (rule.nodes.some((d) => d.type === "decl" && hasCq(d.value))) cqRules.push(rule);
  });
  for (const rule of cqRules) {
    const blocks = [];
    const copyOf = (model) => {
      const copy = rule.clone();
      copy.walkDecls((d) => {
        d.value = toViewport(d.value, model);
      });
      return copy;
    };
    blocks.push(copyOf(null));
    for (const container of Object.values(inner)) {
      if (!container.scope?.test(rule.selector)) continue;
      for (const model of container.models) {
        const media = postcss.atRule({ name: "media", params: model.media });
        media.append(copyOf(model));
        blocks.push(media);
      }
    }
    const wrap = postcss.atRule({ name: "supports", params: NO_CONTAINER });
    wrap.append(...blocks);
    rule.after(tight(wrap));
    cqCopies++;
  }

  // 2b. `lh` (Chromium 109): the source writes a fallback before each use
  // (`min-height: 4.5em; min-height: 3lh`), and the minifier keeps only the
  // last, so 99 to 108 lost the reserved rows that keep the button still.
  // The line height is the rule's own when it sets a number, else the app
  // root's 1.45 (pearl.css `.nx-app`).
  const lhRules = [];
  root.walkRules((rule) => {
    if (inside(rule, isKeyframes) || inside(rule, isOurs)) return;
    if (rule.nodes.some((d) => d.type === "decl" && LH.test(d.value))) lhRules.push(rule);
  });
  for (const rule of lhRules) {
    const own = rule.nodes.find((d) => d.type === "decl" && d.prop === "line-height" && /^\d*\.?\d+$/.test(d.value.trim()));
    const lineHeight = own ? Number(own.value) : 1.45;
    const copy = rule.clone();
    copy.walkDecls((d) => {
      d.value = d.value.replace(LH_ALL, (_, n) => `${round(Number(n) * lineHeight)}em`);
    });
    const wrap = postcss.atRule({ name: "supports", params: NO_LH });
    wrap.append(copy);
    rule.after(tight(wrap));
    lhCopies++;
  }

  // 3. `@container`: a media twin of each.
  const containers = [];
  root.walkAtRules("container", (at) => {
    if (inside(at, isOurs)) return;
    if (inside(at, isContainer)) {
      problems.push(`@container inside @container is not mirrored: @container ${at.params}`);
      return;
    }
    containers.push(at);
  });
  for (const at of containers) {
    const read = readContainer(at.params);
    if (!read) {
      problems.push(`@container ${at.params}: cannot read it`);
      continue;
    }
    const wrap = postcss.atRule({ name: "supports", params: NO_CONTAINER });
    if (read.name === "app") {
      const range = readCondition(read.condition);
      if (!range) {
        problems.push(`@container ${at.params}: only min/max width/height in px are mirrored`);
        continue;
      }
      const media = postcss.atRule({ name: "media", params: read.condition });
      for (const child of at.nodes) media.append(child.clone());
      media.walkDecls((d) => {
        if (!hasCq(d.value)) return;
        // Measured against an inner container that is there in every
        // window this rule applies to, or else against the app root.
        const rule = d.parent;
        const selector = rule.type === "rule" ? rule.selector : "";
        let model = null;
        for (const container of Object.values(inner)) {
          if (!container.scope?.test(selector)) continue;
          const fit = container.models.find((m) => within(range, readCondition(m.media) ?? {}));
          if (fit) model = fit;
        }
        d.value = toViewport(d.value, model);
      });
      wrap.append(media);
    } else {
      const container = read.name ? inner[read.name] : undefined;
      if (!container) {
        problems.push(`@container ${at.params}: no model for the container "${read.name ?? "(unnamed)"}" in INNER`);
        continue;
      }
      for (const model of container.models) {
        const condition = innerCondition(read.condition, model);
        if (!condition) {
          problems.push(`@container ${at.params}: cannot place it on the window`);
          continue;
        }
        const media = postcss.atRule({ name: "media", params: condition });
        for (const child of at.nodes) media.append(child.clone());
        media.walkDecls((d) => {
          d.value = toViewport(d.value, model);
        });
        wrap.append(media);
      }
      if (!wrap.nodes?.length) continue;
    }
    at.after(tight(wrap));
    twins++;
  }

  // Containers declared that no model covers: their cq units would be read
  // against the window.
  root.walkDecls(/^container(-name)?$/, (d) => {
    const name = d.prop === "container" ? d.value.split("/")[0].trim() : d.value.trim();
    for (const n of name.split(/\s+/)) {
      if (n && n !== "app" && n !== "none" && !inner[n]) problems.push(`container "${n}" has no model in INNER`);
    }
  });

  return { css: root.toString(), problems, twins, fallbacks: cqCopies, hasCopies, lhCopies };
}

/** The build step: every CSS file of a build, once it is final. */
export function oldEngineCss(options = {}) {
  return {
    name: "nx-old-engine-css",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
        const source = typeof file.source === "string" ? file.source : new TextDecoder().decode(file.source);
        const out = transformCss(source, options);
        file.source = out.css;
        for (const problem of out.problems) this.warn(`old-engine CSS: ${problem}`);
        options.onResult?.(file.fileName, out, source);
      }
    },
  };
}
