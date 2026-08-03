/* Neoxify website -- progressive enhancement only.
 *
 * Nothing here is required for the site to work. Navigation, forms and every
 * piece of content function with scripting disabled; this file just makes the
 * result nicer. If you add to it, keep that property: no content should ever
 * depend on this file having run.
 *
 * Plain ES5-compatible syntax and no dependencies, so it runs anywhere the
 * CSS does without a build step.
 */
(function () {
  "use strict";

  var doc = document;

  // The stylesheet assumes no-JS until told otherwise, so scroll-reveal
  // elements start visible and only become animatable once we're sure the
  // observer can actually reveal them again.
  doc.documentElement.classList.remove("no-js");

  /* ------------------------------------------------------------------
   * Mobile navigation
   * ---------------------------------------------------------------- */

  var toggle = doc.querySelector("[data-nav-toggle]");
  var drawer = doc.querySelector("[data-nav-drawer]");

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

  /* ------------------------------------------------------------------
   * Scroll reveal
   * ---------------------------------------------------------------- */

  var revealables = doc.querySelectorAll(".reveal");

  // Nothing is hidden by the stylesheet on its own -- .is-armed does the
  // hiding, and it is only ever applied here, immediately before observing
  // the element. If this block never runs, or the browser has no observer,
  // the content simply appears without animating. Content must never depend
  // on a script having succeeded.
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

    for (var i = 0; i < revealables.length; i++) {
      revealables[i].classList.add("is-armed");
      observer.observe(revealables[i]);
    }

    // Safety net. An observer can exist and still never deliver an entry --
    // observed for real in a non-compositing browser context during testing.
    // On a normal load the elements above the fold intersect immediately and
    // are revealed within milliseconds, so if nothing at all has been
    // revealed by now, the observer is not doing its job. Unarm everything:
    // the animation is worth losing, a page of invisible text is not.
    window.setTimeout(function () {
      if (doc.querySelector(".reveal.is-visible")) {
        return;
      }
      for (var k = 0; k < revealables.length; k++) {
        revealables[k].classList.remove("is-armed");
      }
    }, 2000);
  }

  /* ------------------------------------------------------------------
   * Launch announcement
   * ---------------------------------------------------------------- */

  var announce = doc.querySelector("[data-announce]");

  if (announce) {
    var storeKey = announce.getAttribute("data-announce-key") || "nx-announce";
    var lastFocus = null;
    var seen = false;

    try {
      seen = window.localStorage.getItem(storeKey) === "1";
    } catch (err) {
      // Private browsing can throw on localStorage access. Treat that as
      // "not seen yet" -- showing once a visit is better than never showing.
      seen = false;
    }

    var closeAnnounce = function () {
      announce.hidden = true;
      doc.documentElement.classList.remove("nx-locked");
      try {
        window.localStorage.setItem(storeKey, "1");
      } catch (err2) {
        // Nothing to do -- it just means it may appear again next visit.
      }
      if (lastFocus && lastFocus.focus) {
        lastFocus.focus();
      }
    };

    var openAnnounce = function () {
      lastFocus = doc.activeElement;
      announce.hidden = false;
      doc.documentElement.classList.add("nx-locked");
      // Move focus into the dialog so a keyboard user isn't left behind it.
      var closeButton = announce.querySelector(".announce__x");
      if (closeButton && closeButton.focus) {
        closeButton.focus();
      }
    };

    if (!seen) {
      // A short beat, so it doesn't slam into the page mid-render.
      window.setTimeout(openAnnounce, 1400);
    }

    var closers = announce.querySelectorAll("[data-announce-close]");
    for (var c = 0; c < closers.length; c++) {
      closers[c].addEventListener("click", closeAnnounce);
    }

    doc.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !announce.hidden) {
        closeAnnounce();
      }
    });
  }

  /* ------------------------------------------------------------------
   * Form submit feedback
   * ---------------------------------------------------------------- */

  var forms = doc.querySelectorAll("form[data-form]");

  Array.prototype.forEach.call(forms, function (form) {
    form.addEventListener("submit", function () {
      var button = form.querySelector("[data-submit]");
      if (!button) {
        return;
      }

      var busyLabel = button.getAttribute("data-busy-label");
      if (busyLabel) {
        button.textContent = busyLabel;
      }

      // aria-disabled rather than disabled: a genuinely disabled button is
      // not submitted with the form on some browsers, which would silently
      // drop the click that got us here.
      button.setAttribute("aria-disabled", "true");
    });
  });
})();
