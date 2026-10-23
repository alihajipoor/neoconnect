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
    routes();
    pointer();
    map();
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
  /* ======================================================= route finder
   * The illustration on the home and features pages. Its whole cycle is
   * CSS (transform and opacity); this only runs it while it is on screen
   * and restarts it from the "play again" button. Without this file, or
   * with reduced motion, it holds its final frame: connected, checked. */
  function routes() {
    var figs = $$("[data-route]");
    if (!figs.length) { return; }
    function restart(fig) {
      if (fig.getAnimations) {
        fig.getAnimations({ subtree: true }).forEach(function (a) { a.cancel(); a.play(); });
      }
    }
    figs.forEach(function (fig) {
      var btn = $("[data-route-replay]", fig);
      if (reduceMotion) {
        if (btn) { btn.hidden = true; }
        return;
      }
      if (btn) {
        btn.addEventListener("click", function () {
          if (!fig.classList.contains("is-run")) { fig.classList.add("is-run"); } else { restart(fig); }
        });
      }
    });
    if (reduceMotion || !("IntersectionObserver" in window)) { return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        // Starts from the beginning each time it comes back into view.
        e.target.classList.toggle("is-run", e.isIntersecting);
      });
    }, { threshold: 0.35 });
    figs.forEach(function (fig) { io.observe(fig); });
  }

  /* ================================================== pointer niceties
   * For a fine pointer only, and never under reduced motion: a light that
   * follows the cursor over cards and plans, a slight tilt on the hero logo
   * and the phone, a magnetic pull on the big primary buttons. Each writes
   * custom properties on its own element (CSSOM, so the CSP is untouched)
   * once per frame at most; CSS turns them into transforms. */
  function pointer() {
    var fine = false;
    try { fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) { /* touch */ }
    if (!fine || reduceMotion || !window.requestAnimationFrame) { return; }

    function onFrame(fn) {
      var queued = false, last = null;
      return function (ev) {
        last = ev;
        if (queued) { return; }
        queued = true;
        window.requestAnimationFrame(function () { queued = false; fn(last); });
      };
    }

    // Light on cards and plans.
    $$(".card, .plan").forEach(function (el) {
      el.addEventListener("pointerenter", function () { el.classList.add("is-lit"); });
      el.addEventListener("pointerleave", function () { el.classList.remove("is-lit"); });
      el.addEventListener("pointermove", onFrame(function (ev) {
        var r = el.getBoundingClientRect();
        el.style.setProperty("--mx", Math.round(ev.clientX - r.left) + "px");
        el.style.setProperty("--my", Math.round(ev.clientY - r.top) + "px");
      }));
    });

    // Tilt: the pointer anywhere over the area turns the target a little.
    [[".hero", ".hero__mark", 10], [".showcase__stage", ".showcase__scene", 6]].forEach(function (cfg) {
      var area = $(cfg[0]), target = area && $(cfg[1], area), max = cfg[2];
      if (!target) { return; }
      area.addEventListener("pointermove", onFrame(function (ev) {
        var r = target.getBoundingClientRect();
        var x = (ev.clientX - (r.left + r.width / 2)) / Math.max(r.width, 300);
        var y = (ev.clientY - (r.top + r.height / 2)) / Math.max(r.height, 300);
        x = Math.max(-1, Math.min(1, x)); y = Math.max(-1, Math.min(1, y));
        target.style.setProperty("--ry", (x * max).toFixed(2) + "deg");
        target.style.setProperty("--rx", (-y * max).toFixed(2) + "deg");
      }));
      area.addEventListener("pointerleave", function () {
        target.style.setProperty("--ry", "0deg");
        target.style.setProperty("--rx", "0deg");
      });
    });

    // Magnet: a few pixels toward the pointer, back on leave.
    $$(".btn--magnet").forEach(function (btn) {
      btn.addEventListener("pointermove", onFrame(function (ev) {
        var r = btn.getBoundingClientRect();
        var cap = function (v) { return Math.max(-6, Math.min(6, v)).toFixed(1) + "px"; };
        btn.style.setProperty("--bx", cap((ev.clientX - r.left - r.width / 2) * 0.12));
        btn.style.setProperty("--by", cap((ev.clientY - r.top - r.height / 2) * 0.25));
      }));
      btn.addEventListener("pointerleave", function () {
        btn.style.setProperty("--bx", "0px");
        btn.style.setProperty("--by", "0px");
      });
    });
  }

  /* =========================================================== the map
   * Pointing at (or tabbing to) a country in the list lights its light on
   * the map beside it; the lights themselves name themselves in CSS. */
  function map() {
    $$("[data-map]").forEach(function (m) {
      var scope = m.closest("section") || doc;
      $$(".loc[data-cc]", scope).forEach(function (row) {
        var lamp = $('.lamp[data-cc="' + row.getAttribute("data-cc") + '"]', m);
        if (!lamp) { return; }
        function on() { lamp.classList.add("is-lit"); }
        function off() { lamp.classList.remove("is-lit"); }
        row.addEventListener("pointerenter", on);
        row.addEventListener("pointerleave", off);
      });
    });
  }
})();
