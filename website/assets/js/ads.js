/* Google ads measurement, for visitors who came from one of our Google ads.
 *
 * NOBODY ELSE EVER RUNS THIS FILE. The page's loader adds it only on a
 * request the server recognised as an ad click (a gclid, gbraid or wbraid
 * in the address), a later page of an allowed ad visit (the nx_ad session
 * cookie), or the privacy page's "turn it off" link. See inc/ads.php.
 *
 *   In Europe (by the browser's time zone; unknown counts as Europe) the
 *   visitor is asked first. Nothing from Google loads and nothing is stored
 *   until "Allow". "No thanks" is remembered for the visit in sessionStorage,
 *   which is not a cookie and never leaves the browser.
 *   Elsewhere the tag loads without asking. The privacy page says so and
 *   has the link that turns it off for this browser (localStorage).
 *
 * Allowed: the nx_ad session cookie is set (so the server opens the next
 * page's policy header too), consent is set -- ad storage and ad user data
 * granted, ad personalisation and analytics storage denied, this site does
 * no remarketing and no analytics -- and Google's tag is added.
 *
 * A tap on a download choice pushes one event onto the tag's queue. It
 * never waits for Google and never cancels the click: with Google's script
 * blocked, slow or failed, the download behaves exactly as without this file.
 *
 * Trusted because the hashed loader inserted it ('strict-dynamic'), and the
 * Google script is trusted because this inserted it. Plain ES5, no
 * innerHTML, no inline styles.
 */
(function () {
  "use strict";

  var doc = document;
  var me = doc.currentScript;
  var cfg = null;
  try { cfg = JSON.parse(me.getAttribute("data-nx-ads")); } catch (e) { return; }
  if (!cfg || !cfg.tag) { return; }

  var OFF_KEY = "nx-ads-off";   /* localStorage: "1" = never, in this browser */
  var VISIT_KEY = "nx-ads";     /* sessionStorage: "no" = said no this visit  */
  var path = cfg.path || "/";
  var loaded = false;

  function get(store, key) { try { return window[store].getItem(key); } catch (e) { return null; } }
  function put(store, key, v) { try { window[store].setItem(key, v); } catch (e) { /* not kept; harmless */ } }
  function hasMarker() { return /(?:^|;\s*)nx_ad=1(?:;|$)/.test(doc.cookie); }
  function secure() { return location.protocol === "https:" ? "; secure" : ""; }

  function setMarker() {
    doc.cookie = "nx_ad=1; path=" + path + "; samesite=lax" + secure();
  }

  /* Every cookie this file or Google's tag can have set here, on every
   * domain form the tag may have used (it picks the widest it can). */
  function forget() {
    var names = ["nx_ad", "_gcl_au", "_gcl_aw", "_gcl_gb", "_gcl_dc", "_gcl_ag", "_gcl_gs", "_gcl_ha"];
    var host = location.hostname, parts = host.split("."), domains = [""];
    for (var i = 0; i < parts.length - 1; i++) { domains.push("; domain=" + parts.slice(i).join(".")); }
    names.forEach(function (n) {
      domains.forEach(function (d) {
        ["/", path].forEach(function (p) {
          doc.cookie = n + "=; path=" + p + d + "; max-age=0; samesite=lax" + secure();
        });
      });
    });
  }

  function europe() {
    var tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { tz = ""; }
    /* Unknown, or a zone that names no place (UTC, Etc/...), as privacy
     * browsers report: ask, as for Europe. */
    if (!tz || tz === "UTC" || tz === "GMT" || tz.indexOf("Etc/") === 0) { return true; }
    if (tz.indexOf("Europe/") === 0) { return true; }
    return [
      "Atlantic/Reykjavik", "Atlantic/Canary", "Atlantic/Madeira", "Atlantic/Azores", "Atlantic/Faroe",
      "Arctic/Longyearbyen", "Asia/Nicosia", "Asia/Famagusta",
      /* EU regions outside Europe's map */
      "America/Guadeloupe", "America/Martinique", "America/Cayenne", "America/St_Martin",
      "Indian/Reunion", "Indian/Mayotte"
    ].indexOf(tz) !== -1;
  }

  /* Restricted countries, by time zone: never the tag, never the question,
   * even with a click id in the address (a link can be posted anywhere).
   * The server skips them by country header too, but that header is often
   * missing, so this is the check that always runs. */
  function restricted() {
    var tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { tz = ""; }
    return ["Asia/Tehran"].indexOf(tz) !== -1;
  }

  function gtag() { window.dataLayer.push(arguments); }

  function load() {
    if (loaded) { return; }
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    /* Before the tag, as Google's consent documentation requires. */
    gtag("consent", "default", {
      ad_storage: "granted",
      ad_user_data: "granted",
      ad_personalization: "denied",
      analytics_storage: "denied"
    });
    gtag("set", "allow_ad_personalization_signals", false);
    gtag("set", "allow_google_signals", false);
    gtag("js", new Date());
    var s = doc.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtm.js?id=" + encodeURIComponent(cfg.tag);
    doc.head.appendChild(s);
  }

  /* Download choices: matched by the address they go to, from the same
   * config the download page is built from. */
  function platformOf(a) {
    var links = cfg.links || {}, href;
    try { href = new URL(a.getAttribute("href"), location.href).href; } catch (e) { return ""; }
    for (var k in links) {
      if (!Object.prototype.hasOwnProperty.call(links, k)) { continue; }
      try { if (new URL(links[k], location.href).href === href) { return k; } } catch (e) { /* skip */ }
    }
    return "";
  }

  function listen() {
    doc.addEventListener("click", function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
      if (!a || !loaded) { return; }
      var p = platformOf(a);
      if (!p) { return; }
      try {
        gtag("event", "download_click", { platform: p });
        if (cfg.sendTo) { gtag("event", "conversion", { send_to: cfg.sendTo }); }
      } catch (e) { /* measurement never gets in the way */ }
    }, true);
  }

  function allow() {
    setMarker();
    load();
  }

  /* The question. Built here so no other visitor's page carries a byte of
   * it; styled by assets/css/ads.css, inlined on these requests only. */
  function ask() {
    var main = doc.getElementById("main");
    if (!main) { return; }
    var bar = doc.createElement("section");
    bar.className = "adsbar";
    bar.setAttribute("aria-label", cfg.label || "");
    var wrap = doc.createElement("div");
    wrap.className = "wrap";
    var box = doc.createElement("div");
    box.className = "adsbar__box";
    var p = doc.createElement("p");
    p.className = "adsbar__text";
    p.id = "adsbar-text";
    p.appendChild(doc.createTextNode(cfg.text + " "));
    if (cfg.privacy) {
      var more = doc.createElement("a");
      more.href = cfg.privacy;
      more.textContent = cfg.more;
      p.appendChild(more);
    }
    var actions = doc.createElement("div");
    actions.className = "adsbar__actions";
    function button(label, fn) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "btn btn--ghost btn--sm";
      b.textContent = label;
      b.setAttribute("aria-describedby", "adsbar-text");
      b.addEventListener("click", function () {
        var hadFocus = bar.contains(doc.activeElement);
        fn();
        bar.parentNode.removeChild(bar);
        if (hadFocus) { main.setAttribute("tabindex", "-1"); main.focus({ preventScroll: true }); }
      });
      return b;
    }
    actions.appendChild(button(cfg.allow, allow));
    actions.appendChild(button(cfg.deny, function () { put("sessionStorage", VISIT_KEY, "no"); }));
    box.appendChild(p);
    box.appendChild(actions);
    wrap.appendChild(box);
    bar.appendChild(wrap);
    main.insertBefore(bar, main.firstChild);
  }

  function ready(fn) {
    if (doc.readyState === "loading") { doc.addEventListener("DOMContentLoaded", fn); } else { fn(); }
  }

  /* ------------------------------------------------------------ decide */
  if (cfg.mode === "off") {
    put("localStorage", OFF_KEY, "1");
    forget();
    ready(function () {
      var done = doc.querySelector("[data-ads-off-done]");
      if (done) { done.hidden = false; }
    });
    return;
  }
  if (get("localStorage", OFF_KEY) === "1") {
    if (hasMarker()) { forget(); }
    return;
  }

  if (restricted()) {
    if (hasMarker()) { forget(); }
    return;
  }
  listen();
  if (hasMarker()) {          /* a later page of a visit already allowed */
    load();
    return;
  }
  if (cfg.mode !== "click") { return; }
  if (get("sessionStorage", VISIT_KEY) === "no") { return; }
  if (!europe()) {
    allow();
    return;
  }
  ready(ask);
})();
