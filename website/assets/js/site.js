/* Neoxify website -- progressive enhancement only.
 *
 * THE RULE THIS FILE LIVES BY: nothing here is required for the site to
 * work. Navigation, every form, the plans and the FAQ are rendered
 * server-side and work with scripting off. This only makes the result nicer.
 *
 * Loaded asynchronously by the hashed loader in inc/partials/head.php,
 * which has already swapped no-js for js on <html> before the first paint
 * (that is what folds the phone menu away without a flash). So this file
 * may run before the document has finished parsing: everything waits for
 * DOMContentLoaded.
 *
 * Trusted-Types-clean and CSP-clean: no innerHTML, no eval, no inline
 * styles -- text goes in through textContent, state through classes.
 * Plain ES5, no dependencies, no build step.
 */
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;

  function ready(fn) {
    if (doc.readyState === "loading") { doc.addEventListener("DOMContentLoaded", fn); } else { fn(); }
  }
  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }

  var reduceMotion = false;
  try { reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { /* treat as allowed */ }

  ready(function () {
    if (root.className.indexOf("js") === -1) { root.className += " js"; }
    nav();
    theme();
    announcement();
    forms();
  });

  /* ================================================================ nav */
  function nav() {
    var toggle = $("[data-nav-toggle]");
    var drawer = $("[data-nav-drawer]");
    if (!toggle || !drawer) { return; }

    function set(open) {
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      drawer.classList.toggle("is-open", open);
    }
    set(false);

    toggle.addEventListener("click", function () {
      set(toggle.getAttribute("aria-expanded") !== "true");
    });
    doc.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        set(false);
        toggle.focus();
      }
    });
    doc.addEventListener("click", function (event) {
      if (toggle.getAttribute("aria-expanded") !== "true") { return; }
      if (drawer.contains(event.target) || toggle.contains(event.target)) { return; }
      set(false);
    });
  }

  /* ============================================================== theme
   * Light / dark. The server already painted the right theme from the
   * cookie (head.php sets data-theme before anything renders), so this only
   * handles the click: flip data-theme, remember it for a year, and keep
   * aria-pressed and the browser's theme-color honest. With no cookie the
   * page follows the system, and aria-pressed follows it too. */
  function theme() {
    var btn = $("[data-theme-toggle]");
    if (!btn) { return; }
    var mq = null;
    try { mq = window.matchMedia("(prefers-color-scheme: dark)"); } catch (e) { /* no system preference */ }
    var colors = { light: "#F1F3F6", dark: "#090B12" };

    function current() {
      var t = root.getAttribute("data-theme");
      if (t === "light" || t === "dark") { return t; }
      return mq && mq.matches ? "dark" : "light";
    }
    function sync() {
      var t = current();
      btn.setAttribute("aria-pressed", t === "dark" ? "true" : "false");
      if (root.getAttribute("data-theme")) {
        $$('meta[name="theme-color"]').forEach(function (m) {
          m.setAttribute("content", colors[t]);
          m.removeAttribute("media");
        });
        var cs = $('meta[name="color-scheme"]');
        if (cs) { cs.setAttribute("content", t); }
      }
    }
    function apply(next) {
      root.setAttribute("data-theme", next);
      var path = btn.getAttribute("data-cookie-path") || "/";
      document.cookie = "theme=" + next + "; path=" + path + "; max-age=31536000; samesite=lax" +
        (location.protocol === "https:" ? "; secure" : "");
      sync();
    }

    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      // A soft cross-fade where the browser can do it for free.
      if (doc.startViewTransition && !reduceMotion) {
        doc.startViewTransition(function () { apply(next); });
      } else {
        apply(next);
      }
    });
    if (mq) {
      if (mq.addEventListener) { mq.addEventListener("change", sync); } else if (mq.addListener) { mq.addListener(sync); }
    }
    sync();
  }

  /* ======================================================= announcement
   * Ships visible; the loader hid it before the first paint for anyone
   * who dismissed it before. This only records a dismissal. */
  function announcement() {
    var box = $("[data-announce]");
    if (!box) { return; }
    var key = box.getAttribute("data-announce-key") || "nx-announce";
    $$("[data-announce-close]", box).forEach(function (btn) {
      btn.addEventListener("click", function () {
        root.className += " ann-off";
        try { window.localStorage.setItem(key, "1"); } catch (e) { /* it may come back; harmless */ }
      });
    });
  }

  /* ============================================================== forms */
  function forms() {
    $$("form[data-form]").forEach(function (form) {
      form.addEventListener("submit", function () {
        var button = $("[data-submit]", form);
        if (!button) { return; }
        var busy = button.getAttribute("data-busy-label");
        if (busy) { button.textContent = busy; }
        button.setAttribute("aria-disabled", "true");
      });
    });
  }
})();
