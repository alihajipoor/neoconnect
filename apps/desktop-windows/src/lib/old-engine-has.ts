/** `:has()` for a Windows web component older than Chromium 105.
 *
 * WebView2 99 to 104 has no `:has()`, and a rule whose selector uses it is
 * dropped whole there. Most of the app's uses are cosmetic (a paused
 * animation under a dialog, a pointer cursor); these few decide what is
 * laid out or shown, so each gets a stand-in: an attribute kept on the
 * same element by `startHasFallback` below, only on an engine without
 * `:has()`, and a copy of each rule with `:has(<child>)` replaced by that
 * attribute, emitted by the build (scripts/old-engine-css.mjs) inside
 * `@supports not selector(:has(a))`. An engine with `:has()` never sees
 * either: the copies are inside a condition it answers "no" to, and the
 * observer is never started.
 *
 * `child` is the selector inside `:has()` as the built stylesheet writes
 * it (no spaces); the build checks every `:has()` it finds against this
 * list and `HAS_COSMETIC`, and old-engine-css.test.ts fails on one in
 * neither. */
export interface HasFallback {
  /** The element `:has()` is on. */
  host: string;
  /** The argument of `:has()`, as the built CSS writes it. */
  child: string;
  /** The attribute that stands in for it on `host`. */
  attr: string;
}

export const HAS_FALLBACKS: readonly HasFallback[] = [
  // Sign-in with a message on it: the card steps down so the button stays
  // on screen (pages.css, the `.nx-auth:has(.nx-msg)` rules).
  { host: ".nx-auth", child: ".nx-msg", attr: "data-nx-has-msg" },
  // The sentence's reserve: a hint that lays out its longest sentence
  // keeps no minimum of its own (pearl.css, `.nx-hint`).
  { host: ".nx-hint", child: ">.rsv", attr: "data-nx-has-rsv" },
  // Phone layout: under a message to read the reserve gives way.
  { host: ".nx-hero-copy", child: '>.nx-mapstage[data-alert="1"]', attr: "data-nx-has-alert" },
];

/** `:has()` arguments that only change how something looks or moves, and
 * are left to drop on an old engine. */
export const HAS_COSMETIC: readonly string[] = [
  // The pointer cursor on a checkbox's label.
  "input[type=checkbox]",
  // Map lights paused while a dialog, a menu or a sheet covers them.
  ">.nx-dlgwrap,>.nx-menu",
  ">.nx-sheet",
];

/** Whether this engine understands `:has()`. */
export function supportsHas(css: { supports?(condition: string): boolean } | undefined = globalThis.CSS): boolean {
  try {
    return Boolean(css?.supports?.("selector(:has(a))"));
  } catch {
    // An engine that cannot even be asked is treated as one without it.
    return false;
  }
}

/** Sets each fallback's attribute on every `host` that has its `child`,
 * and takes it off every one that has not. */
export function syncHasAttributes(root: ParentNode, fallbacks: readonly HasFallback[] = HAS_FALLBACKS): void {
  for (const { host, child, attr } of fallbacks) {
    // ">.rsv" is a child, ".nx-msg" any descendant: both read from the host.
    const inner = `:scope ${child}`;
    root.querySelectorAll(host).forEach((el) => {
      const has = el.querySelector(inner) !== null;
      if (el.hasAttribute(attr) !== has) {
        if (has) el.setAttribute(attr, "");
        else el.removeAttribute(attr);
      }
    });
  }
}

/** On an engine without `:has()` only: keeps the stand-in attributes in
 * step with the page, once per frame at most. Does nothing elsewhere.
 * Returns whether it started. */
export function startHasFallback(doc: Document = document): boolean {
  if (supportsHas()) return false;
  let queued = false;
  const run = () => {
    queued = false;
    syncHasAttributes(doc);
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  };
  new MutationObserver(queue).observe(doc.documentElement, {
    subtree: true,
    childList: true,
    // `data-alert` decides one of them; class changes can add a child
    // that matches.
    attributes: true,
    attributeFilter: ["class", "data-alert"],
  });
  run();
  return true;
}
