#!/usr/bin/env node
// DEV ONLY: does the phone's main page fit one screen, and keep still?
//
// Starts the dev preview (preview.html, served by Vite on a free local
// port), drives a headless Chrome through its state switcher over the
// DevTools protocol, and for each phone size x language x main-page state
// measures:
//   - how far anything in the frame could scroll (scrollHeight -
//     clientHeight of every scroller, the locations list excepted);
//   - whether each part that says the state or acts on it -- the chip, the
//     line, the sentence, a banner, the device limit, notes, an error, the
//     failover line, the location, the button -- is on screen between the
//     header and the nav;
//   - whether any text in those parts, the button row or the summary line
//     is cut: clipped sideways or ellipsized, or a caution dropped from the
//     summary line (which shows whole pieces only);
// and, across the states of one size and language:
//   - that the foot keeps still: the location card, the button row, the
//     primary button's top, bottom and starting edge, and the summary line
//     are in the same place in every state that has them;
//   - that the map's stage and the mark keep one size and place in every
//     state with no message to read (a banner, the device limit, an error
//     make the stage give way), so a brief gap or a longer sentence never
//     moves or hides them. The failover line that names a country is the
//     one sustained message that takes room from the stage: the states that
//     show it are compared with each other.
// The sign-in screens are measured at the window and tablet sizes too.
// Exits 1 on any failure. Nothing leaves the machine: the preview answers
// every Tauri call itself.
//
//   node scripts/check-phone-fit.mjs [--app mobile] [--all] [--json out.json]
//                                     [--chrome path] [--text-scale 1.15]
//
// --app mobile measures the phone app itself instead (apps/mobile, its own
// preview.html and stylesheet, `pnpm check:phone-fit` there): its main page
// in the states the phone has -- a declined VPN permission, a protocol not
// in the app, a disconnect not confirmed among them -- and the sign-in
// screens at the phone sizes and the tablet. The first-run disclosure is
// measured too, and only reported: it is longer than a screen, and scrolls.
//
// --all adds the states a phone never shows (Gaming mode and "not confined"
// are Windows-only); they are reported but not failed on.
//
// --text-scale k multiplies every element's font size by k, an
// approximation of Android's font scale (WebView textZoom) in desktop
// Chrome -- not a device. Report only: past what the screen holds, the
// column scrolling is the documented last resort, so it fails nothing.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const MOBILE = opt("app") === "mobile";
const root = path.resolve(here, MOBILE ? "../../mobile" : "..");

/** The preview's own labels (src/preview/PreviewApp.tsx `SIZES`). */
const SIZES = [
  "360 × 640 (small Android)",
  "375 × 667 (iPhone SE)",
  "390 × 844 (phone)",
  "412 × 915 (Android)",
  "430 × 932 (large iPhone)",
];
/** The windows and the tablet, for sign-in only: the card does not scroll
 * there either (AuthFrame.tsx), the first launch's 1180 x 760 included. */
const WINDOWS = MOBILE
  ? ["834 × 1112 (tablet)"]
  : ["720 × 600 (minimum)", "940 × 700 (old default)", "1180 × 760 (first launch)", "1280 × 800", "1440 × 900", "834 × 1112 (tablet)"];
const LANGS = ["en", "fa"];
/** The phone app's own states (apps/mobile/src/preview/PhonePreview.tsx):
 * no "waiting for a network" pass or unknown status there, and the states
 * only a phone has -- a declined VPN permission, a protocol the app does
 * not carry, a disconnect the platform has not confirmed. */
const MOBILE_MAIN = [
  "idle",
  "connecting",
  "verifying",
  "connected",
  "adopted",
  "unverified",
  "degraded",
  "reconnectHeld",
  "reconnectLong",
  "reconnectOffline",
  "disconnecting",
  "teardownStuck",
  "dropped",
  "failed",
  "permission",
  "unsupported",
  "slot",
  "blocked",
  "capped",
  "ended",
  "none",
  "relayConnected",
  "relayUnverified",
  "relayPinned",
  "crossed",
  "crossedUnverified",
];
const MAIN = MOBILE ? MOBILE_MAIN : [
  "idle",
  "connecting",
  "verifying",
  "connected",
  "adopted",
  "unverified",
  "degraded",
  "reconnectHeld",
  "reconnectLong",
  "noNetwork",
  "unknown",
  "disconnecting",
  "dropped",
  "failed",
  "slot",
  "blocked",
  "capped",
  "ended",
  "none",
  "relayConnected",
  "relayUnverified",
  "relayPinned",
  "crossed",
  "crossedDegraded",
];
const WINDOWS_ONLY = MOBILE ? [] : ["unconfined", "gamingOff", "gamingOn", "gamingUnknown"];
/** A message to read is on screen: the stage gives way (it keeps its place
 * and draws nothing), so its size is not compared. */
const ALERT = new Set(
  MOBILE
    ? ["failed", "slot", "blocked", "ended", "none", "teardownStuck", "permission", "unsupported"]
    : ["failed", "slot", "blocked", "ended"],
);
/** No subscription: another foot altogether (no summary line; on the real
 * screen no location card either). The device limit's card replaces the
 * button. Neither is compared with the others' foot. */
const OTHER_FOOT = new Set(["none", "slot"]);
/** The failover line that names a country: compared among themselves. */
const CROSSED = new Set(MOBILE ? ["crossed", "crossedUnverified"] : ["crossed", "crossedDegraded"]);
/** The phone draws no location card without a plan. */
const NO_LOCATION = new Set(MOBILE ? ["none"] : []);
/** Sign-in and its steps (the preview's "Screen"), which the owner asked to
 * fit one screen too: no scrolling, every button that submits on screen --
 * the backup route's sign-up offer among them -- and no provider's label
 * cut. With the states a blocked network brings, which are the ones a
 * customer in Iran sees: a failure, the intranet's note, both, and the
 * backup route offered; and an iPhone's three providers. */
const MOBILE_AUTH = ["signin", "signinError", "register", "forgot", "verify"];
const AUTH = MOBILE ? MOBILE_AUTH : [
  "signin",
  "signinNotice",
  "signinError",
  "signinIntranet",
  "signinIntranetError",
  "signinIos",
  "register",
  "registerError",
  "registerRelayOffer",
  "registerIos",
  "forgot",
  "verify",
];

function chromePath() {
  if (opt("chrome")) return opt("chrome");
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"],
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  }[process.platform] ?? [];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("No Chrome found: pass --chrome <path> or set CHROME_PATH.");
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether the page's utility CSS has applied: a run once measured a page
 * whose `flex` classes computed as blocks. */
const STYLED = `(() => {
  const probe = document.createElement('div');
  probe.className = 'flex items-center';
  document.body.appendChild(probe);
  const ok = getComputedStyle(probe).display === 'flex' && getComputedStyle(probe).alignItems === 'center';
  probe.remove();
  const pearl = document.querySelector('[data-testid=frame] .nx-hero-copy');
  return ok && !!pearl && getComputedStyle(pearl).display === 'flex';
})()`;

const MEASURE = (noLocation) => `(() => {
  const frame = document.querySelector('[data-testid=frame]');
  const fb = frame.getBoundingClientRect();
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const R = (el) => {
    const b = el.getBoundingClientRect();
    return { t: b.top - fb.top, b: b.bottom - fb.top, l: b.left - fb.left, r: b.right - fb.left, w: b.width, h: b.height };
  };
  const rtl = getComputedStyle(frame.querySelector('.nx-app') || frame).direction === 'rtl';
  let overflow = 0;
  for (const el of frame.querySelectorAll('*')) {
    if (el.closest('.nx-loclist')) continue;
    if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY) || !vis(el)) continue;
    overflow = Math.max(overflow, el.scrollHeight - el.clientHeight);
  }
  const copy = frame.querySelector('.nx-hero-copy');
  const nav = frame.querySelector('.nx-mnav');
  const navTop = vis(nav) ? R(nav).t : fb.height;
  const head = frame.querySelector('.nx-mhead');
  const headBottom = vis(head) ? R(head).b : 0;
  const one = (sel) => [...copy.querySelectorAll(':scope > ' + sel)].find(vis) || null;
  const missing = [];
  const required = [['chip', '.nx-chiprow'], ['line', '.nx-bigrow'], ${noLocation ? "" : "['location', '.nx-hloc'], "}['button', '.nx-actions, .nx-slot']];
  const optional = [['sentence', '.nx-hint'], ['banner', '.nx-banner'], ['slot', '.nx-slot'], ['notes', '.nx-notes'], ['error', '.nx-err'], ['failover', '.nx-sublinebox > .nx-subline']];
  for (const [name, sel] of [...required, ...optional]) {
    const el = one(sel);
    if (!el) {
      if (required.some(([n]) => n === name)) missing.push(name + ' missing');
      continue;
    }
    const r = R(el);
    if (r.h > 0 && (r.t < headBottom - 0.5 || r.b > navTop + 0.5)) missing.push(name + ' off screen');
  }
  // Text that is cut: clipped sideways, or ellipsized.
  const cut = [];
  const parts = '.nx-chiprow, .nx-bigrow, .nx-hint, .nx-banner, .nx-slot, .nx-notes, .nx-err, .nx-subline, .nx-hloc, .nx-actions, .nx-sumline';
  for (const box of copy.querySelectorAll(parts)) {
    for (const el of [box, ...box.querySelectorAll('*')]) {
      // The screen reader's words are clipped on purpose.
      if (!vis(el) || el instanceof SVGElement || el.classList.contains('nx-sr') || !(el.textContent || '').trim()) continue;
      const cs = getComputedStyle(el);
      const clips = cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis';
      if (clips && el.scrollWidth > el.clientWidth + 1) {
        cut.push((el.className || el.tagName) + ' "' + (el.textContent || '').trim().slice(0, 40) + '"');
      }
    }
  }
  // The summary line shows whole pieces; one that does not fit drops to a
  // line the box does not show. A caution (days or data running out) must
  // never be the one dropped.
  const dropped = [];
  const sum = copy.querySelector('.nx-sumline .nx-sum');
  if (sum && vis(sum)) {
    const sb = sum.getBoundingClientRect();
    for (const piece of sum.children) {
      if (piece.getBoundingClientRect().top >= sb.bottom - 0.5) {
        dropped.push(piece.className);
        if (piece.classList.contains('caution') || piece.querySelector('.caution')) cut.push('caution dropped from the summary line: "' + piece.textContent.trim() + '"');
      }
    }
  }
  const rect = (el) => {
    if (!el || !vis(el)) return null;
    const r = R(el);
    return { t: r.t, b: r.b, s: rtl ? fb.width - r.r : r.l, e: rtl ? fb.width - r.l : r.r };
  };
  const actions = one('.nx-actions');
  const primary = actions ? [...actions.querySelectorAll(':scope > .nx-btn:not(.ghost)')].find(vis) : null;
  const stageEl = one('.nx-mapstage');
  const mark = stageEl ? [...stageEl.querySelectorAll('.nx-mark')].find(vis) : null;
  return {
    overflow: Math.round(overflow),
    missing,
    cut,
    dropped,
    // For the JSON: each part's height, to see what took the room.
    parts: Object.fromEntries([...copy.querySelectorAll(':scope > *, :scope > .nx-sublinebox > *')].filter(vis).map((el) => [String(el.className).split(' ').find((c) => c.startsWith('nx-') && c !== 'nx-glass') || el.tagName, Math.round(R(el).h * 10) / 10])),
    foot: {
      location: rect(one('.nx-hloc')),
      row: rect(actions),
      primary: primary ? (({ t, b, s }) => ({ t, b, s }))(rect(primary)) : null,
      summary: rect(one('.nx-sumline')),
    },
    stage: stageEl ? (({ t, b }) => ({ t, b }))(rect(stageEl)) : null,
    mark: mark ? (({ t, s, e }) => ({ t, s, e }))(rect(mark)) : null,
  };
})()`;

/** A sign-in screen: how far anything scrolls; whether every button that
 * submits, and every message, lies inside the safe area; and whether any
 * provider button's content is cut. */
const AUTH_MEASURE = `(() => {
  const frame = document.querySelector('[data-testid=frame]');
  const fb = frame.getBoundingClientRect();
  const [safeT, safeB] = (frame.dataset.safe || '0,0').split(',').map(Number);
  const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  let overflow = 0;
  for (const el of frame.querySelectorAll('*')) {
    if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY) || !vis(el)) continue;
    overflow = Math.max(overflow, el.scrollHeight - el.clientHeight);
  }
  const missing = [];
  const onScreen = (el) => {
    const b = el.getBoundingClientRect();
    return b.top - fb.top >= safeT - 0.5 && b.bottom - fb.top <= fb.height - safeB + 0.5;
  };
  const card = frame.querySelector('.nx-auth-card');
  const submits = [...frame.querySelectorAll('.nx-auth-submit')].filter(vis);
  if (!card) missing.push('card missing');
  if (!submits.length) missing.push('button missing');
  submits.forEach((el, i) => {
    if (!onScreen(el)) missing.push((i ? 'button ' + (i + 1) : 'button') + ' off screen');
  });
  for (const msg of [...frame.querySelectorAll('.nx-auth-card .nx-msg')].filter(vis)) {
    if (!onScreen(msg)) missing.push('message off screen');
  }
  const cut = [];
  for (const btn of [...frame.querySelectorAll('.nx-soc')].filter(vis)) {
    const bb = btn.getBoundingClientRect();
    const spill = [...btn.querySelectorAll('*')].filter(vis).some((el) => {
      const r = el.getBoundingClientRect();
      return r.left < bb.left - 0.5 || r.right > bb.right + 0.5;
    });
    if (spill || btn.scrollWidth > btn.clientWidth + 1) cut.push('provider "' + (btn.getAttribute('aria-label') || '') + '" cut');
  }
  const providers = [...frame.querySelectorAll('.nx-soc')].filter(vis).length;
  return { overflow: Math.round(overflow), missing, cut, providers };
})()`;

/** The disclosure: how far its column scrolls, and whether its button, once
 * scrolled to, lies inside the safe area and is not cut. */
const DISCLOSURE_MEASURE = `(() => {
  const frame = document.querySelector('[data-testid=frame]');
  const fb = frame.getBoundingClientRect();
  const [safeT, safeB] = (frame.dataset.safe || '0,0').split(',').map(Number);
  const scroller = frame.querySelector('.nx-auth-scroll');
  const button = frame.querySelector('.nx-auth-submit');
  if (!scroller || !button) return { overflow: -1, reached: false };
  const overflow = Math.round(scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = scroller.scrollHeight;
  const b = button.getBoundingClientRect();
  const reached = b.top - fb.top >= safeT - 0.5 && b.bottom - fb.top <= fb.height - safeB + 0.5;
  scroller.scrollTop = 0;
  return { overflow, reached };
})()`;

/** Where two measures of the same part differ by more than half a pixel. */
function differs(a, b) {
  if (a === null || b === null) return a !== b;
  return Object.keys(a).some((k) => Math.abs(a[k] - b[k]) > 0.5);
}
const show = (r) => (r === null ? "none" : Object.entries(r).map(([k, v]) => `${k}${Math.round(v)}`).join(" "));

const states = flag("all") ? [...MAIN, ...WINDOWS_ONLY] : MAIN;
const textScale = Number(opt("text-scale") ?? 1);
if (!(textScale >= 1 && textScale <= 2)) throw new Error("--text-scale takes a number from 1 to 2.");
/** Every element's font size times k, as absolute pixels so nothing
 * compounds; the last scaling undone first, so a part that stays between
 * states is not scaled twice. */
const SCALE_TEXT = (k) => `(() => {
  const els = [...document.querySelectorAll('[data-testid=frame] *')];
  for (const el of els) {
    if (el.dataset.fitFz === undefined) continue;
    el.style.fontSize = el.dataset.fitFz;
    delete el.dataset.fitFz;
  }
  const sizes = els.map((el) => parseFloat(getComputedStyle(el).fontSize));
  els.forEach((el, i) => {
    el.dataset.fitFz = el.style.fontSize;
    el.style.fontSize = sizes[i] * ${k} + 'px';
  });
  return true;
})()`;
const port = await freePort();
const server = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  logLevel: "error",
  server: { port, strictPort: true, host: "127.0.0.1", hmr: false },
});
await server.listen();

const cdpPort = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nx-fit-"));
const chrome = spawn(chromePath(), ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--window-size=1600,1300", "about:blank"], {
  stdio: "ignore",
});

let ws;
const results = [];
const authResults = [];
const disclosure = [];
try {
  let targets = [];
  for (let i = 0; i < 80 && !targets.some((t) => t.type === "page"); i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    } catch {
      await sleep(250);
    }
  }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.result.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result.result.value;
  };
  const choose = (testid, value) =>
    ev(`(() => {
      const el = document.querySelector('[data-testid="${testid}"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === ${JSON.stringify(value)};
    })()`);
  const styled = async () => {
    for (let i = 0; i < 40; i++) {
      if (await ev(STYLED).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };

  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1300, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/preview.html` });
  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.querySelector('[data-testid=scenario]')").catch(() => false)) break;
    await sleep(250);
  }
  await ev("document.fonts.ready.then(() => true)");
  if (!(await styled())) throw new Error("The preview's CSS never applied: nothing measured.");
  await choose("theme", "light");
  for (const size of SIZES) {
    if (!(await choose("size", size))) throw new Error(`The preview has no size "${size}".`);
    for (const lang of LANGS) {
      await choose("language", lang);
      for (const state of states) {
        if (!(await choose("scenario", state))) throw new Error(`The preview has no state "${state}".`);
        await sleep(state.startsWith("gaming") ? 900 : 350);
        if (!(await styled())) throw new Error(`The preview's CSS was not applied at ${size} ${lang} ${state}.`);
        if (textScale !== 1) {
          await ev(SCALE_TEXT(textScale));
          await sleep(200);
        }
        const m = await ev(MEASURE(NO_LOCATION.has(state)));
        results.push({ size: size.split(" (")[0], lang, state, ...m, windowsOnly: WINDOWS_ONLY.includes(state) });
      }
    }
  }
  // Sign-in and its steps.
  for (const size of [...SIZES, ...WINDOWS]) {
    await choose("size", size);
    for (const lang of LANGS) {
      await choose("language", lang);
      for (const screen of AUTH) {
        // An iPhone's three providers at a Windows window's size are a
        // screen nobody sees: phones and the tablet only.
        if (screen.endsWith("Ios") && WINDOWS.includes(size) && !size.includes("tablet")) continue;
        if (!(await choose("screen", screen))) throw new Error(`The preview has no screen "${screen}".`);
        await sleep(450);
        await ev("document.fonts.ready.then(() => true)");
        if (textScale !== 1) {
          await ev(SCALE_TEXT(textScale));
          await sleep(200);
        }
        const m = await ev(AUTH_MEASURE);
        authResults.push({ size: size.split(" (")[0], lang, screen, ...m });
      }
    }
  }
  // The phone's first-run disclosure: longer than a screen, so it scrolls
  // -- reported, not failed on: how far, and that its button is reached.
  if (MOBILE) {
    for (const size of SIZES) {
      await choose("size", size);
      for (const lang of LANGS) {
        await choose("language", lang);
        if (!(await choose("screen", "disclosure"))) throw new Error('The preview has no screen "disclosure".');
        await sleep(450);
        await ev("document.fonts.ready.then(() => true)");
        disclosure.push({ size: size.split(" (")[0], lang, ...(await ev(DISCLOSURE_MEASURE)) });
      }
    }
  }
  await choose("screen", "main");
} finally {
  ws?.close();
  chrome.kill();
  await server.close();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a lock for a moment; the folder is in the OS temp.
  }
}

// What moves between states of one size and language.
const moved = [];
for (const size of [...new Set(results.map((r) => r.size))]) {
  for (const lang of LANGS) {
    const rows = results.filter((r) => r.size === size && r.lang === lang && !r.windowsOnly);
    const footRows = rows.filter((r) => !OTHER_FOOT.has(r.state));
    for (const part of ["location", "row", "primary", "summary"]) {
      const base = footRows.find((r) => r.foot[part] !== null);
      if (!base) continue;
      for (const r of footRows) {
        if (differs(base.foot[part], r.foot[part])) moved.push(`${size} ${lang}: ${part} in ${r.state} (${show(r.foot[part])}) differs from ${base.state} (${show(base.foot[part])})`);
      }
    }
    for (const group of [rows.filter((r) => !ALERT.has(r.state) && !OTHER_FOOT.has(r.state) && !CROSSED.has(r.state)), rows.filter((r) => CROSSED.has(r.state))]) {
      const [base, ...rest] = group;
      for (const r of rest) {
        for (const part of ["stage", "mark"]) {
          if (differs(base[part], r[part])) moved.push(`${size} ${lang}: ${part} in ${r.state} (${show(r[part])}) differs from ${base.state} (${show(base[part])})`);
        }
      }
    }
  }
}

if (opt("json")) fs.writeFileSync(opt("json"), JSON.stringify({ main: results, auth: authResults, disclosure }, null, 1));
for (const r of disclosure) {
  console.log(`${r.size} ${r.lang} disclosure: scrolls ${r.overflow}px, its button ${r.reached ? "reached at the end" : "NOT reached"}`);
}
const disclosureFailed = disclosure.filter((r) => !r.reached);
// The iPhone screens must actually draw three providers, or they prove
// nothing about them.
for (const r of authResults) {
  if (r.screen.endsWith("Ios") && r.providers !== 3) r.missing.push(`${r.providers} providers drawn, not 3`);
}
const authFailed = authResults.filter((r) => r.overflow > 0 || r.missing.length > 0 || r.cut.length > 0);
for (const size of [...new Set(authResults.map((r) => r.size))]) {
  for (const lang of LANGS) {
    const rows = authResults.filter((r) => r.size === size && r.lang === lang);
    const bad = rows.filter((r) => r.overflow > 0 || r.missing.length || r.cut.length);
    console.log(
      `${size} ${lang} sign-in: ${rows.length} screens, largest overflow ${Math.max(...rows.map((r) => r.overflow))}px` +
        (bad.length ? `; ${bad.map((r) => `${r.screen} ${r.overflow}px ${[...r.missing, ...r.cut].join(" ")}`.trim()).join(", ")}` : ""),
    );
  }
}
const failed = results.filter((r) => !r.windowsOnly && (r.overflow > 0 || r.missing.length > 0 || r.cut.length > 0));
for (const size of [...new Set(results.map((r) => r.size))]) {
  for (const lang of LANGS) {
    const rows = results.filter((r) => r.size === size && r.lang === lang);
    const worst = Math.max(...rows.filter((r) => !r.windowsOnly).map((r) => r.overflow));
    const bad = rows.filter((r) => r.overflow > 0 || r.missing.length || r.cut.length);
    const marks = new Set(rows.filter((r) => !r.windowsOnly && !ALERT.has(r.state) && !OTHER_FOOT.has(r.state)).map((r) => (r.mark ? Math.round(r.mark.e - r.mark.s) : 0)));
    console.log(
      `${size} ${lang}: ${rows.length} states, largest overflow ${worst}px, mark ${[...marks].map((s) => (s ? `${s}px` : "hidden")).join(" / ")}` +
        (bad.length
          ? `; ${bad.map((r) => `${r.state}${r.windowsOnly ? " (Windows only)" : ""} ${r.overflow}px ${[...r.missing, ...r.cut.map((c) => `cut ${c}`)].join(" ")}`.trim()).join(", ")}`
          : ""),
    );
  }
}
for (const line of moved) console.log(`moved: ${line}`);
if (textScale !== 1) {
  const scrolls = results.filter((r) => !r.windowsOnly && r.overflow > 0);
  console.log(
    `Text at ${textScale}x (an approximation, not a device): ${scrolls.length} of ${results.filter((r) => !r.windowsOnly).length} states scroll in the column` +
      (scrolls.length ? `: ${scrolls.map((r) => `${r.size} ${r.lang} ${r.state} ${r.overflow}px`).join(", ")}` : "."),
  );
  process.exit(0);
}
if (failed.length || moved.length || authFailed.length || disclosureFailed.length) {
  if (disclosureFailed.length) console.error(`${disclosureFailed.length} disclosure screen(s) whose button cannot be reached.`);
  if (failed.length) console.error(`${failed.length} main-page state(s) do not fit, or cut their text.`);
  if (authFailed.length) console.error(`${authFailed.length} sign-in screen(s) do not fit one screen, or cut a provider's label.`);
  if (moved.length) console.error(`${moved.length} part(s) move or resize with the state.`);
  process.exit(1);
}
console.log("Every main-page state fits one screen, cuts no text, and the foot, the stage and the mark keep still; every sign-in screen fits one screen.");
