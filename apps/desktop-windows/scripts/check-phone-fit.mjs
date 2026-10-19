#!/usr/bin/env node
// DEV ONLY: does the phone's main page fit one screen?
//
// Starts the dev preview (preview.html, served by Vite on a free local
// port), drives a headless Chrome through its state switcher over the
// DevTools protocol, and for each phone size x language x main-page state
// measures how far anything in the frame could scroll (scrollHeight -
// clientHeight of every scroller, the locations list excepted) and whether
// the chip, the state line, the location card and the primary button are
// on screen above the nav. Exits 1 on any overflow. Nothing leaves the
// machine: the preview answers every Tauri call itself.
//
//   node scripts/check-phone-fit.mjs [--all] [--json out.json] [--chrome path]
//
// --all adds the states a phone never shows (Gaming mode and "not confined"
// are Windows-only); they are reported but not failed on.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** The preview's own labels (src/preview/PreviewApp.tsx `SIZES`). */
const SIZES = [
  "360 × 640 (small Android)",
  "375 × 667 (iPhone SE)",
  "390 × 844 (phone)",
  "412 × 915 (Android)",
  "430 × 932 (large iPhone)",
];
const LANGS = ["en", "fa"];
const MAIN = [
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
];
const WINDOWS_ONLY = ["unconfined", "gamingOff", "gamingOn", "gamingUnknown"];

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

const MEASURE = `(() => {
  const frame = document.querySelector('[data-testid=frame]');
  const fb = frame.getBoundingClientRect();
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const R = (el) => { const b = el.getBoundingClientRect(); return { t: b.top - fb.top, b: b.bottom - fb.top }; };
  let overflow = 0;
  for (const el of frame.querySelectorAll('*')) {
    if (el.closest('.nx-loclist')) continue;
    if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY) || !vis(el)) continue;
    overflow = Math.max(overflow, el.scrollHeight - el.clientHeight);
  }
  const nav = frame.querySelector('.nx-mnav');
  const navTop = vis(nav) ? R(nav).t : fb.height;
  const missing = [];
  for (const [name, sel] of [['chip', '.nx-chip'], ['line', '.nx-bigrow'], ['location', '.nx-hloc'], ['button', '.nx-actions .nx-btn, .nx-slot .nx-btn']]) {
    const el = [...frame.querySelectorAll('.nx-hero-copy ' + sel.split(', ').join(', .nx-hero-copy '))].find(vis);
    if (!el) { missing.push(name + ' missing'); continue; }
    const r = R(el);
    if (r.t < 0 || r.b > navTop + 0.5) missing.push(name + ' off screen');
  }
  return { overflow: Math.round(overflow), missing };
})()`;

const states = flag("all") ? [...MAIN, ...WINDOWS_ONLY] : MAIN;
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

  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1300, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/preview.html` });
  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.querySelector('[data-testid=scenario]')").catch(() => false)) break;
    await sleep(250);
  }
  await ev("document.fonts.ready.then(() => true)");
  await choose("theme", "light");
  for (const size of SIZES) {
    if (!(await choose("size", size))) throw new Error(`The preview has no size "${size}".`);
    for (const lang of LANGS) {
      await choose("language", lang);
      for (const state of states) {
        if (!(await choose("scenario", state))) throw new Error(`The preview has no state "${state}".`);
        await sleep(state.startsWith("gaming") ? 900 : 350);
        const m = await ev(MEASURE);
        results.push({ size: size.split(" (")[0], lang, state, ...m, windowsOnly: WINDOWS_ONLY.includes(state) });
      }
    }
  }
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

if (opt("json")) fs.writeFileSync(opt("json"), JSON.stringify(results, null, 1));
const failed = results.filter((r) => !r.windowsOnly && (r.overflow > 0 || r.missing.length > 0));
for (const size of [...new Set(results.map((r) => r.size))]) {
  for (const lang of LANGS) {
    const rows = results.filter((r) => r.size === size && r.lang === lang);
    const worst = Math.max(...rows.filter((r) => !r.windowsOnly).map((r) => r.overflow));
    const bad = rows.filter((r) => r.overflow > 0 || r.missing.length);
    console.log(
      `${size} ${lang}: ${rows.length} states, largest overflow ${worst}px` +
        (bad.length ? `; ${bad.map((r) => `${r.state}${r.windowsOnly ? " (Windows only)" : ""} ${r.overflow}px ${r.missing.join(" ")}`.trim()).join(", ")}` : ""),
    );
  }
}
if (failed.length) {
  console.error(`${failed.length} main-page state(s) do not fit.`);
  process.exit(1);
}
console.log("Every main-page state fits one screen.");
