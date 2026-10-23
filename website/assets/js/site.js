/* Neoxify website — progressive enhancement only.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE LIVES BY: nothing here is required for the site to work.
 *
 * Navigation, every form, the plans and the FAQ are rendered server-side
 * and function with scripting disabled. This file only makes the result nicer. If you add
 * to it, keep that property — no content may ever depend on this file having
 * run.
 *
 * Three inversions exist specifically to hold that line, and all three must
 * be preserved:
 *
 *   1. The mobile drawer ships VISIBLE and is hidden here, once we know we
 *      can reopen it. Hidden-in-markup plus a script that never runs leaves a
 *      phone with no navigation at all.
 *   2. The announcement ships VISIBLE; this only re-hides it for someone who
 *      already dismissed it.
 *   3. `.reveal` elements ship UNHIDDEN. `.is-armed` does the hiding and is
 *      only ever added immediately before observing, plus there is a bail-out
 *      timer below.
 * ---------------------------------------------------------------------------
 *
 * Plain ES5-compatible syntax and no dependencies, so it runs anywhere the
 * CSS does without a build step.
 */
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;

  // The stylesheet assumes no-JS until told otherwise.
  root.classList.remove("no-js");

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { /* no matchMedia: treat as motion allowed */ }

  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $$(sel, ctx) {
    return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel));
  }

  /* ==================================================================
   * Mobile navigation
   * ================================================================ */

  var toggle = $("[data-nav-toggle]");
  var drawer = $("[data-nav-drawer]");

  if (toggle && drawer) {
    // Only hide the drawer now that we know we can open it again.
    drawer.hidden = true;
    toggle.setAttribute("aria-expanded", "false");

    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", open ? "false" : "true");
      drawer.hidden = open;
    });

    // Close on Escape, matching what a keyboard user expects from a menu.
    doc.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        toggle.setAttribute("aria-expanded", "false");
        drawer.hidden = true;
        toggle.focus();
      }
    });
  }

  /* ==================================================================
   * Scroll reveal
   * ================================================================ */

  var revealables = $$(".reveal");

  if (revealables.length && "IntersectionObserver" in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
    );

    revealables.forEach(function (el) {
      el.classList.add("is-armed");
      observer.observe(el);
    });

    // ---- Safety net 1: the observer never delivers anything at all.
    // An observer can exist and still never fire — observed for real in a
    // non-compositing browser context during testing. On a normal load the
    // elements above the fold intersect immediately, so if nothing has been
    // revealed by now the observer is not doing its job. Unarm everything:
    // the animation is worth losing, a page of invisible text is not.
    window.setTimeout(function () {
      if ($(".reveal.is-visible")) { return; }
      revealables.forEach(function (el) { el.classList.remove("is-armed"); });
    }, 2000);

    // ---- Safety net 2: the viewport JUMPED past something.
    // The observer only reports elements that actually cross the viewport.
    // Anchor links, Ctrl+End, a browser restoring a scroll position, and
    // find-in-page all move the viewport in one step and can leave a section
    // that was skipped over still armed — that is, still at opacity 0 — even
    // though the reader is now looking straight at it. Verified: jumping from
    // the middle of the home page to the foot left 25 of 58 elements armed.
    //
    // So sweep on scroll as well: anything now inside the viewport is
    // revealed regardless of whether the observer said so. rAF-throttled, and
    // it detaches itself once everything has been revealed, so it costs
    // nothing for the rest of the session.
    var sweepQueued = false;
    var sweep = function () {
      sweepQueued = false;
      var remaining = doc.querySelectorAll(".reveal.is-armed:not(.is-visible)");
      if (!remaining.length) {
        window.removeEventListener("scroll", onSweepScroll);
        window.removeEventListener("resize", onSweepScroll);
        return;
      }
      var h = window.innerHeight;
      Array.prototype.forEach.call(remaining, function (el) {
        var r = el.getBoundingClientRect();
        if (r.bottom > 0 && r.top < h) { el.classList.add("is-visible"); }
      });
    };
    var onSweepScroll = function () {
      if (!sweepQueued) { sweepQueued = true; window.requestAnimationFrame(sweep); }
    };
    window.addEventListener("scroll", onSweepScroll, { passive: true });
    window.addEventListener("resize", onSweepScroll, { passive: true });
  }

  /* ==================================================================
   * Launch announcement
   * ================================================================ */

  var announce = $("[data-announce]");

  if (announce) {
    var storeKey = announce.getAttribute("data-announce-key") || "nx-announce";

    try {
      if (window.localStorage.getItem(storeKey) === "1") {
        announce.hidden = true;
      }
    } catch (err) {
      // Private browsing can throw on localStorage access. Leaving the
      // banner visible is the harmless outcome.
    }

    $$("[data-announce-close]", announce).forEach(function (btn) {
      btn.addEventListener("click", function () {
        announce.hidden = true;
        try { window.localStorage.setItem(storeKey, "1"); } catch (e2) { /* may reappear */ }
      });
    });
  }

  /* ==================================================================
   * Form submit feedback
   * ================================================================ */

  $$("form[data-form]").forEach(function (form) {
    form.addEventListener("submit", function () {
      var button = $("[data-submit]", form);
      if (!button) { return; }

      var busyLabel = button.getAttribute("data-busy-label");
      if (busyLabel) { button.textContent = busyLabel; }

      // aria-disabled rather than disabled: a genuinely disabled button is
      // not submitted with the form on some browsers, which would silently
      // drop the click that got us here.
      button.setAttribute("aria-disabled", "true");
    });
  });

  /* ==================================================================
   * Reading progress on the right-hand rail
   * ================================================================ */

  var railProg = $("[data-rail-progress]");
  if (railProg) {
    var ticking = false;
    var updateRail = function () {
      var h = doc.documentElement.scrollHeight - window.innerHeight;
      var pct = h > 0 ? (window.pageYOffset / h) * 100 : 0;
      railProg.style.height = Math.max(0, Math.min(100, pct)) + "%";
      ticking = false;
    };
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; window.requestAnimationFrame(updateRail); }
    }, { passive: true });
    updateRail();
  }
})();
