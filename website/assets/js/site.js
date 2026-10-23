/* Neoxify website -- progressive enhancement only.
 *
 * THE RULE THIS FILE LIVES BY: nothing here is required for the site to
 * work. Navigation, every form, the method list, the plans, the FAQ and the
 * whole of the network simulator's content are rendered server-side and
 * work with scripting off. This only makes the result nicer.
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

  /* Persian pages use Persian digits for every number, including the ones
   * this file writes (nx_num() does the same in PHP). Built from U+06F0 so
   * the file stays ASCII whatever charset the server labels it with. */
  var faDigits = root.getAttribute("lang") === "fa";
  function num(v) {
    var s = String(v);
    if (!faDigits) { return s; }
    return s.replace(/[0-9]/g, function (d) { return String.fromCharCode(0x06F0 + Number(d)); });
  }

  ready(function () {
    if (root.className.indexOf("js") === -1) { root.className += " js"; }
    nav();
    theme();
    announcement();
    forms();
    instrument();
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

  /* ========================================================= simulator
   * Switch on the kinds of blocking a network does; the list strikes out
   * the methods that stop working and shows which one the app falls back
   * to. An ILLUSTRATION: it contacts nothing and measures nothing, and the
   * copy beneath it says so. Every string it shows is in the markup. */
  function instrument() {
    var inst = $("[data-instrument]");
    if (!inst) { return; }

    var lanes = $$("[data-lane]", inst);
    var switches = $$("input[data-condition]", inst);
    var elCarry = $("[data-carry]", inst);
    var elHandovers = $("[data-handovers]", inst);
    var elLiveText = $("[data-live-text]", inst);
    var elVerdict = $("[data-verdict]", inst);
    var elLog = $("[data-log]", inst);
    var elLogCount = $("[data-log-count]", inst);

    function T(name) { return inst.getAttribute("data-t-" + name) || ""; }
    function fill(str, vars) {
      var out = str;
      for (var k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) { out = out.split(":" + k).join(vars[k]); }
      }
      return out;
    }
    function text(el, sel) { var n = $(sel, el); return n ? n.textContent.replace(/\s+/g, " ").trim() : ""; }
    function laneName(el) { return el ? text(el, ".nm b") : ""; }
    function laneTech(el) { return el ? text(el, ".nm i") : ""; }
    function laneById(id) {
      for (var i = 0; i < lanes.length; i++) { if (lanes[i].getAttribute("data-lane") === id) { return lanes[i]; } }
      return null;
    }
    function active() { return switches.filter(function (s) { return s.checked; }); }

    var carrying = lanes.length ? lanes[0].getAttribute("data-lane") : null;
    var handovers = 0;
    var allDown = false;
    var lines = [];

    function clock() {
      var d = new Date();
      function z(n) { return n < 10 ? "0" + n : "" + n; }
      return num(z(d.getHours()) + ":" + z(d.getMinutes()) + ":" + z(d.getSeconds()));
    }
    function log(kind, msg) {
      lines.push({ kind: kind, text: msg, at: clock() });
      if (lines.length > 40) { lines.shift(); }
      if (!elLog) { return; }
      while (elLog.firstChild) { elLog.removeChild(elLog.firstChild); }
      for (var i = lines.length - 1; i >= 0; i--) {
        var row = doc.createElement("div");
        row.className = "ln is-" + lines[i].kind;
        var t = doc.createElement("time");
        t.setAttribute("data-ltr", "");
        t.textContent = lines[i].at;
        var s = doc.createElement("span");
        s.textContent = lines[i].text;
        row.appendChild(t);
        row.appendChild(s);
        elLog.appendChild(row);
      }
      if (elLogCount) { elLogCount.textContent = fill(T("lines"), { n: num(lines.length) }); }
    }

    function compute() {
      var dead = {}, relay = false, total = false;
      active().forEach(function (s) {
        var id = s.getAttribute("data-condition");
        if (s.hasAttribute("data-total-condition")) { total = true; }
        if (s.hasAttribute("data-relay-condition")) { relay = true; }
        lanes.forEach(function (el) {
          if ((el.getAttribute("data-blocked-by") || "").split(/\s+/).indexOf(id) !== -1) {
            dead[el.getAttribute("data-lane")] = true;
          }
        });
      });
      if (total) { lanes.forEach(function (el) { dead[el.getAttribute("data-lane")] = true; }); }
      return { dead: dead, relay: relay };
    }

    function render(reason) {
      var st = compute();
      inst.setAttribute("data-relay", st.relay ? "1" : "0");
      var alive = lanes.filter(function (el) { return !st.dead[el.getAttribute("data-lane")]; });
      var next = alive.length ? alive[0].getAttribute("data-lane") : null;

      lanes.forEach(function (el) {
        var id = el.getAttribute("data-lane");
        var isDead = !!st.dead[id];
        var isNext = !isDead && id === next;
        el.classList.toggle("is-dead", isDead);
        el.classList.toggle("is-active", isNext);
        var status = $("[data-lane-status]", el);
        if (status) { status.textContent = isDead ? T("blocked") : (isNext ? T("carrying") : T("standby")); }
      });

      if (next !== carrying) {
        if (next === null) {
          allDown = true;
          log("warn", T("lognone"));
        } else {
          handovers++;
          if (carrying && !allDown) {
            log("warn", fill(T("loglost"), {
              p: laneName(laneById(carrying)),
              r: reason ? fill(T("logreason"), { c: reason }) : ""
            }));
          }
          log("good", fill(T("loghand"), { n: num(handovers), p: laneName(laneById(next)) }));
          allDown = false;
        }
        carrying = next;
        if (next && !reduceMotion) {
          var el2 = laneById(next);
          el2.classList.remove("is-handover");
          void el2.offsetWidth; // restart the animation
          el2.classList.add("is-handover");
        }
      }

      var cur = carrying ? laneById(carrying) : null;
      inst.classList.toggle("is-down", !cur);
      if (elCarry) { elCarry.textContent = cur ? laneName(cur) + " · " + laneTech(cur) : T("noroute"); }
      if (elHandovers) { elHandovers.textContent = num(handovers); }
      if (elLiveText) { elLiveText.textContent = cur ? (st.relay ? T("flowingrelay") : T("flowing")) : T("noroute"); }
      if (elVerdict) {
        if (!cur) {
          elVerdict.textContent = T("vdown");
        } else if (!active().length) {
          elVerdict.textContent = T("vopen");
        } else {
          var name = laneName(cur) + " (" + laneTech(cur) + ")";
          elVerdict.textContent = fill(alive.length === 1 ? T("vone") : T("vmany"), { p: name }) + (st.relay ? T("vrelay") : "");
        }
      }
    }

    switches.forEach(function (s) {
      s.addEventListener("change", function () {
        var row = s.closest ? s.closest(".sw") : s.parentNode;
        render(s.checked && row ? text(row, ".sw__lb b") : null);
      });
    });

    var rnd = $("[data-inst-random]", inst);
    if (rnd) {
      rnd.addEventListener("click", function () {
        switches.forEach(function (s) { s.checked = !s.hasAttribute("data-total-condition") && Math.random() < 0.4; });
        render(null);
      });
    }
    var clr = $("[data-inst-clear]", inst);
    if (clr) {
      clr.addEventListener("click", function () {
        switches.forEach(function (s) { s.checked = false; });
        log("info", T("logopen"));
        render(null);
      });
    }

    render(null);
    if (carrying) { log("info", fill(T("logstart"), { p: laneName(laneById(carrying)) })); }
  }
})();
