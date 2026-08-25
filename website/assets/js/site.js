/* Neoxify website — progressive enhancement only.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE LIVES BY: nothing here is required for the site to work.
 *
 * Navigation, every form, the protocol list, the plans, the FAQ and the
 * interactive panel's entire contents are rendered server-side and function
 * with scripting disabled. This file only makes the result nicer. If you add
 * to it, keep that property — no content may ever depend on this file having
 * run.
 *
 * Four inversions exist specifically to hold that line, and all four must be
 * preserved:
 *
 *   1. The mobile drawer ships VISIBLE and is hidden here, once we know we
 *      can reopen it. Hidden-in-markup plus a script that never runs leaves a
 *      phone with no navigation at all.
 *   2. The announcement ships VISIBLE; this only re-hides it for someone who
 *      already dismissed it.
 *   3. `.reveal` elements ship UNHIDDEN. `.is-armed` does the hiding and is
 *      only ever added immediately before observing, plus there is a bail-out
 *      timer below.
 *   4. The instrument's lanes, switches and copy are all in the markup. This
 *      only toggles classes on them.
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
   * Marquee: stop it while it is off-screen
   * ================================================================ */

  var tick = $("[data-tick]");
  if (tick && "IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        // Outlined display glyphs are not cheap to raster, and there is no
        // reason to pay for it while nobody is looking at the band.
        tick.setAttribute("data-off", entry.isIntersecting ? "0" : "1");
      });
    }, { threshold: 0 }).observe(tick);
  }

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

  /* ==================================================================
   * THE INSTRUMENT
   *
   * Switch on the kinds of blocking a network does; the panel strikes out
   * the connection methods that stop working and shows which one the app
   * would fall back to.
   *
   * It is an ILLUSTRATION of how the client picks a transport — it probes
   * nothing, contacts nothing and measures nothing, and the copy beneath it
   * says so. Everything it displays is already in the markup; this only
   * toggles classes and rewrites the readout.
   * ================================================================ */

  var inst = $("[data-instrument]");

  if (inst) {
    var lanes = $$("[data-lane]", inst);
    var laneBox = $("[data-lanes]", inst);
    var switches = $$("input[data-condition]", inst);
    var elCarry = $("[data-carry]", inst);
    var elHandovers = $("[data-handovers]", inst);
    var elLive = $("[data-live]", inst);
    var elLiveText = $("[data-live-text]", inst);
    var elVerdict = $("[data-verdict]", inst);
    var elLog = $("[data-log]", inst);
    var elLogCount = $("[data-log-count]", inst);
    var beamGlow = $("[data-beam-glow]", inst);
    var beamCore = $("[data-beam-core]", inst);
    var beam = $("[data-beam]", inst);

    // Strings come from data-* attributes, set server-side per locale —
    // there is no inline <script>, because the CSP forbids one.
    function T(name) { return inst.getAttribute("data-t-" + name) || ""; }
    function fill(str, vars) {
      var out = str, k;
      for (k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) {
          out = out.split(":" + k).join(vars[k]);
        }
      }
      return out;
    }

    var carrying = lanes.length ? lanes[0].getAttribute("data-lane") : null;
    var handovers = 0;
    var allDown = false;
    var logLines = [];

    function laneName(el) {
      var b = $(".nm b", el);
      return b ? b.textContent.trim() : "";
    }
    function laneTech(el) {
      var i = $(".nm i", el);
      return i ? i.textContent.trim() : "";
    }
    function laneById(id) {
      for (var i = 0; i < lanes.length; i++) {
        if (lanes[i].getAttribute("data-lane") === id) { return lanes[i]; }
      }
      return null;
    }
    function activeConditions() {
      return switches.filter(function (s) { return s.checked; });
    }

    function clock() {
      var d = new Date();
      var z = function (n) { return n < 10 ? "0" + n : "" + n; };
      return z(d.getHours()) + ":" + z(d.getMinutes()) + ":" + z(d.getSeconds());
    }

    function pushLog(kind, text) {
      logLines.push({ kind: kind, text: text, at: clock() });
      if (logLines.length > 40) { logLines.shift(); }
      renderLog();
    }

    function renderLog() {
      if (!elLog) { return; }
      elLog.textContent = "";
      for (var i = logLines.length - 1; i >= 0; i--) {
        var r = logLines[i];
        var row = doc.createElement("div");
        row.className = "ln is-" + r.kind;

        var time = doc.createElement("time");
        time.setAttribute("data-ltr", "");
        time.textContent = r.at;

        var span = doc.createElement("span");
        // textContent, never innerHTML: these strings are translations and
        // must never be able to introduce markup.
        span.textContent = r.text;

        row.appendChild(time);
        row.appendChild(span);
        elLog.appendChild(row);
      }
      if (elLogCount) {
        elLogCount.textContent = fill(T("lines"), { n: logLines.length });
      }
    }

    function compute() {
      var dead = {}, relay = false, total = false;
      activeConditions().forEach(function (s) {
        var id = s.getAttribute("data-condition");
        if (s.hasAttribute("data-total-condition")) { total = true; }
        if (s.hasAttribute("data-relay-condition")) { relay = true; }
        lanes.forEach(function (el) {
          var blockedBy = (el.getAttribute("data-blocked-by") || "").split(/\s+/);
          if (blockedBy.indexOf(id) !== -1) { dead[el.getAttribute("data-lane")] = true; }
        });
      });
      if (total) {
        lanes.forEach(function (el) { dead[el.getAttribute("data-lane")] = true; });
      }
      return { dead: dead, relay: relay, total: total };
    }

    function drawBeam() {
      if (!beam || !laneBox || !beamGlow || !beamCore) { return; }
      // offsetParent is null when the panel is display:none — measuring then
      // produces a zero-size box and a nonsense path.
      if (!laneBox.offsetParent) { return; }

      var box = laneBox.getBoundingClientRect();
      beam.setAttribute("viewBox", "0 0 " + box.width + " " + box.height);

      var el = carrying ? laneById(carrying) : null;
      if (!el) {
        beamGlow.setAttribute("d", "");
        beamCore.setAttribute("d", "");
        return;
      }

      var lb = el.getBoundingClientRect();
      var y = lb.top - box.top + lb.height / 2;
      var y0 = box.height / 2;
      var d = "M0," + y0 + " C44," + y0 + " 6," + y + " 14," + y + " L" + box.width + "," + y;
      beamGlow.setAttribute("d", d);
      beamCore.setAttribute("d", d);
    }

    function render(reasonLabel) {
      var st = compute();
      inst.setAttribute("data-relay", st.relay ? "1" : "0");

      var alive = lanes.filter(function (el) {
        return !st.dead[el.getAttribute("data-lane")];
      });
      var next = alive.length ? alive[0].getAttribute("data-lane") : null;

      lanes.forEach(function (el) {
        var id = el.getAttribute("data-lane");
        var isDead = !!st.dead[id];
        var isNext = !isDead && id === next;

        el.classList.toggle("is-dead", isDead);
        el.classList.toggle("is-live", !isDead);
        el.classList.toggle("is-active", isNext);

        var status = $("[data-lane-status]", el);
        if (status) {
          status.textContent = isDead
            ? T("blocked")
            : (isNext ? T("carrying") : T("standby"));
        }
      });

      if (next !== carrying) {
        if (next === null) {
          allDown = true;
          pushLog("warn", T("lognone"));
        } else {
          handovers++;
          if (carrying && !allDown) {
            var lost = laneById(carrying);
            pushLog("warn", fill(T("loglost"), {
              p: lost ? laneName(lost) : "",
              r: reasonLabel ? fill(T("logreason"), { c: reasonLabel }) : ""
            }));
          }
          pushLog("good", fill(T("loghand"), {
            n: handovers,
            p: laneName(laneById(next))
          }));
          allDown = false;
        }

        carrying = next;

        if (next && !reduceMotion) {
          var el2 = laneById(next);
          el2.classList.remove("is-handover");
          void el2.offsetWidth;      // force a reflow so the animation restarts
          el2.classList.add("is-handover");
        }
      }

      var cur = carrying ? laneById(carrying) : null;

      if (elCarry) {
        elCarry.textContent = "";
        if (cur) {
          var g = doc.createElement("span");
          g.className = "g";
          g.textContent = laneName(cur) + " · " + laneTech(cur);
          elCarry.appendChild(g);
        } else {
          var bad = doc.createElement("span");
          bad.className = "is-none";
          bad.textContent = T("noroute");
          elCarry.appendChild(bad);
        }
      }

      if (elHandovers) { elHandovers.textContent = handovers; }
      if (elLive) { elLive.classList.toggle("is-down", !cur); }
      if (elLiveText) {
        elLiveText.textContent = cur
          ? (st.relay ? T("flowingrelay") : T("flowing"))
          : T("noroute");
      }

      if (elVerdict) {
        elVerdict.classList.toggle("is-bad", !cur);
        if (!cur) {
          elVerdict.textContent = T("vdown");
        } else if (activeConditions().length === 0) {
          elVerdict.textContent = T("vopen");
        } else {
          var name = laneName(cur) + " (" + laneTech(cur) + ")";
          var tail = st.relay ? T("vrelay") : "";
          elVerdict.textContent =
            (alive.length === 1 ? fill(T("vone"), { p: name }) : fill(T("vmany"), { p: name })) + tail;
        }
      }

      window.requestAnimationFrame(drawBeam);
    }

    switches.forEach(function (s) {
      s.addEventListener("change", function () {
        // Mirror :checked onto a class as well, so the switch still looks
        // switched in a browser without :has() support.
        var row = s.closest ? s.closest(".sw") : s.parentNode;
        if (row) { row.classList.toggle("is-on", s.checked); }

        var label = $(".sw__lb b", row);
        render(s.checked && label ? label.textContent.trim() : null);
      });
    });

    var btnRandom = $("[data-inst-random]", inst);
    if (btnRandom) {
      btnRandom.addEventListener("click", function () {
        switches.forEach(function (s) {
          // Never roll the total-shutdown switch: "nothing works" is a real
          // and honest state, but it is a dead end to land someone on by
          // accident when they asked for an example.
          s.checked = s.hasAttribute("data-total-condition")
            ? false
            : Math.random() < 0.4;
          var row = s.closest ? s.closest(".sw") : s.parentNode;
          if (row) { row.classList.toggle("is-on", s.checked); }
        });
        render(null);
      });
    }

    var btnClear = $("[data-inst-clear]", inst);
    if (btnClear) {
      btnClear.addEventListener("click", function () {
        switches.forEach(function (s) {
          s.checked = false;
          var row = s.closest ? s.closest(".sw") : s.parentNode;
          if (row) { row.classList.remove("is-on"); }
        });
        pushLog("info", T("logopen"));
        render(null);
      });
    }

    window.addEventListener("resize", function () {
      window.requestAnimationFrame(drawBeam);
    }, { passive: true });

    render(null);

    // Seed one opening line so the console reads as a log that has started
    // rather than an empty panel that looks broken. render() cannot produce
    // it: on first paint nothing has changed yet, so there is no handover
    // and nothing to report.
    if (carrying) {
      pushLog("info", fill(T("logstart"), { p: laneName(laneById(carrying)) }));
    }
  }
})();
