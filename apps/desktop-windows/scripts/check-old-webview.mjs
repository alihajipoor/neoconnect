#!/usr/bin/env node
// DEV ONLY, by hand, not in CI: does the built main page lay out on an old
// Windows web component?
//
// WebView2 / Chromium 99 to 104 has no container queries, and the app's
// layouts are written as container queries; the build gives such an engine
// the same layouts as media queries (scripts/old-engine-css.mjs). This
// renders the BUILT stylesheet -- the one that ships, twins and all -- in the
// engines it is given, through the dev preview (preview.html?fill: the real
// main page with sample state and no Tauri, the frame filling the browser
// window as the app fills its window), and asserts at each window size and
// language, not connected and connected:
//   - one mode switch ("VPN | Gaming") is visible, never two (none on a
//     phone, where it is in the sheet);
//   - the sidebar, the tablet header's tabs or the phone's bottom nav is
//     visible;
//   - the locations can be reached: the panel, or the location card that
//     opens them;
//   - the headline is drawn above 20px;
//   - nothing visible lies over the connect button.
// And that the sidebar, panel, headline, button and tray are drawn where the
// first engine (`--reference`) draws them: a part one draws and the other
// does not fails, and how far each is moved is reported; and saves a screenshot of
// each. Exits 1 on any failed assertion. Nothing leaves the machine: the
// preview answers every Tauri call itself, and the engines run headless.
//
//   node scripts/check-old-webview.mjs --reference <chrome.exe>
//        --chrome <chrome.exe> [--chrome <chrome.exe> ...]
//        [--out <dir>] [--sizes 1150x780,700x700,360x640] [--langs en,fa]
//
// Old engines are not installed by this script. One way to get them, into a
// scratch folder of your own (each playwright-core version downloads the
// Chromium it was released with):
//   npm i playwright-core@1.19.2   -> Chromium 100   (chromium-965416)
//   npm i playwright-core@1.24.2   -> Chromium 104   (chromium-1015)
//   npm i playwright-core@1.25.2   -> Chromium 105   (chromium-1019)
//   PLAYWRIGHT_BROWSERS_PATH=<scratch>/browsers node node_modules/playwright-core/cli.js install chromium
// then pass <scratch>/browsers/chromium-<n>/chrome-win/chrome.exe. Delete the
// folder afterwards: an old Chromium is not a browser to keep around.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const opt = (name, fallback) => opts(name)[0] ?? fallback;

const reference = opt("reference");
const engines = [reference, ...opts("chrome")].filter(Boolean);
if (engines.length < 2) {
  console.error("Usage: --reference <current chrome.exe> --chrome <old chrome.exe> [--chrome ...]");
  process.exit(2);
}
const out = path.resolve(opt("out", path.join(os.tmpdir(), "nx-old-webview")));
const sizes = opt("sizes", "1150x780,700x700,360x640")
  .split(",")
  .map((s) => s.split("x").map(Number));
const langs = opt("langs", "en,fa").split(",");
const STATES = ["idle", "connected"];
const VERBOSE = args.includes("--verbose");
// `--probe <expression>`: a value of your own, read in each render and printed.
const PROBE = opt("probe");
fs.mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// 1. The stylesheet that ships: a production build, kept in a scratch dir.
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "nx-oldwv-dist-"));
await build({ root, configFile: path.join(root, "vite.config.ts"), logLevel: "error", build: { outDir: dist, emptyOutDir: true } });
const cssFile = fs.readdirSync(path.join(dist, "assets")).find((f) => f.endsWith(".css"));
const builtCss = fs.readFileSync(path.join(dist, "assets", cssFile), "utf8");
// The build set it to production, and the preview runs only on a dev server.
process.env.NODE_ENV = "development";

// 2. The preview, with that stylesheet in place of the dev one: nothing
// re-processes it (no PostCSS), and its fonts are served from the build.
const port = await freePort();
const server = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  logLevel: "error",
  publicDir: dist,
  css: { postcss: { plugins: [] } },
  plugins: [
    {
      name: "nx-built-css",
      enforce: "pre",
      load(id) {
        if (id.replace(/\\/g, "/").split("?")[0].endsWith("/src/globals.css")) return builtCss;
        return null;
      },
    },
  ],
  server: { port, strictPort: true, host: "127.0.0.1", hmr: false },
});
await server.listen();

// What is measured, in the page. Plain ES2017, for the oldest engine.
const MEASURE = `(() => {
  const shown = (el) => {
    if (!el) return false;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  const box = (el) => { if (!shown(el)) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  const q = (s) => document.querySelector('[data-testid=frame] ' + s);
  const all = (s) => Array.prototype.slice.call(document.querySelectorAll('[data-testid=frame] ' + s));
  const button = q('.nx-hero-copy .nx-actions .nx-btn.primary');
  const tag = q('.nx-tag');
  const over = [];
  if (shown(button)) {
    const b = button.getBoundingClientRect();
    // Anything with its own text, drawn over the button's box.
    all('*').forEach((el) => {
      if (el === button || button.contains(el) || el.contains(button)) return;
      const text = Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim());
      if (!text || !shown(el)) return;
      const r = el.getBoundingClientRect();
      const x = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const y = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (x > 1 && y > 1) over.push((el.className && el.className.baseVal === undefined ? el.className : el.tagName) + ': ' + el.textContent.trim().slice(0, 30));
    });
    // And what a press there would reach.
    for (const fx of [0.15, 0.5, 0.85]) for (const fy of [0.3, 0.7]) {
      const hit = document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy);
      if (hit && !button.contains(hit)) over.push('press reaches ' + (hit.className && hit.className.baseVal === undefined ? hit.className : hit.tagName));
    }
  }
  return {
    container: CSS.supports('container-type: size'),
    has: CSS.supports('selector(:has(a))'),
    modebars: all('.nx-modebar').filter(shown).length,
    nav: [q('.nx-side'), q('.nx-mtabs'), q('.nx-mnav')].some(shown),
    locations: shown(q('.nx-panel')) || shown(q('.nx-hloc')),
    tagPx: tag ? parseFloat(getComputedStyle(tag).fontSize) : 0,
    button: box(button),
    over: over,
    column: all('.nx-hero-copy > *').filter(shown).map((el) => String(el.className).split(' ').slice(-1)[0] + ' ' + box(el).join(',')),
    boxes: { side: box(q('.nx-side')), panel: box(q('.nx-panel')), tag: box(tag), button: box(button), tray: box(q('.nx-tray')) },
  };
})()`;

async function open(exe) {
  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nx-oldwv-"));
  const child = spawn(exe, ["--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let targets = [];
  for (let i = 0; i < 80 && !targets.some((t) => t.type === "page"); i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    } catch {
      await sleep(250);
    }
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error(`${exe}: no page to drive`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") logs.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") logs.push(`${m.params.entry.text} ${m.params.entry.url ?? ""}`);
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
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400));
    return res.result?.result?.value;
  };
  await send("Runtime.enable");
  await send("Log.enable");
  const version = (await send("Browser.getVersion")).result?.product ?? exe;
  const close = () => {
    try {
      ws.close();
    } catch {}
    child.kill();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1500);
  };
  return { send, ev, version, close, logs };
}

const choose = (testid, value) => `(() => {
  const el = document.querySelector('[data-testid="${testid}"]');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value === ${JSON.stringify(value)};
})()`;

const results = [];
let failed = 0;
try {
  for (const exe of engines) {
    const b = await open(exe);
    const tagName = b.version.replace(/[^\w.]+/g, "-");
    try {
      for (const [w, h] of sizes) {
        await b.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await b.send("Page.navigate", { url: `http://127.0.0.1:${port}/preview.html?fill` });
        let ready = false;
        for (let i = 0; i < 80 && !ready; i++) {
          ready = await b.ev("!!document.querySelector('[data-testid=scenario]')").catch(() => false);
          if (!ready) await sleep(250);
        }
        if (!ready) throw new Error(`${b.version}: the preview did not start: ${b.logs.slice(0, 5).join(" | ")}`);
        await b.ev("document.fonts.ready.then(() => true)");
        await b.ev(choose("theme", "light"));
        await b.ev(choose("glass", "auto"));
        for (const lang of langs) {
          await b.ev(choose("language", lang));
          for (const state of STATES) {
            await b.ev(choose("scenario", state));
            await sleep(900);
            const m = await b.ev(MEASURE);
            if (PROBE) m.probe = await b.ev(PROBE).catch((e) => String(e));
            const shot = await b.send("Page.captureScreenshot", { format: "png" });
            const file = path.join(out, `${tagName}-${w}x${h}-${lang}-${state}.png`);
            fs.writeFileSync(file, Buffer.from(shot.result.data, "base64"));
            const errors = [];
            // One on a window and a tablet; on a phone (under 640px) it is in
            // the sheet the summary line opens, so none on the page itself.
            if (m.modebars > 1 || (m.modebars === 0 && w >= 640)) errors.push(`${m.modebars} mode switches visible`);
            if (!m.nav) errors.push("no navigation visible");
            if (!m.locations) errors.push("no way to the locations");
            if (!(m.tagPx > 20)) errors.push(`headline ${m.tagPx}px`);
            if (!m.button) errors.push("no connect button visible");
            if (m.over.length) errors.push(`over the button: ${m.over.slice(0, 4).join("; ")}`);
            results.push({ engine: b.version, exe, size: `${w}x${h}`, lang, state, ...m, errors, file });
          }
        }
      }
    } finally {
      b.close();
    }
  }
} finally {
  await server.close();
  fs.rmSync(dist, { recursive: true, force: true });
}

// How far each engine's boxes are from the reference's.
const ref = results.filter((r) => r.exe === reference);
for (const r of results) {
  const base = ref.find((x) => x.size === r.size && x.lang === r.lang && x.state === r.state);
  let worst = 0;
  const off = [];
  for (const [k, a] of Object.entries(r.boxes)) {
    const z = base?.boxes[k];
    if (!a !== !z) {
      off.push(`${k} ${a ? "shown" : "missing"}`);
      worst = Infinity;
      // A part the reference draws and this engine does not, or the other
      // way round, is a different layout.
      r.errors.push(`${k} ${a ? "shown" : "missing"}, unlike the reference`);
      continue;
    }
    if (!a) continue;
    const d = Math.max(...a.map((v, i) => Math.abs(v - z[i])));
    if (d > 2) off.push(`${k} ${d}px`);
    worst = Math.max(worst, d);
  }
  r.offReference = worst;
  const line = `${r.engine.padEnd(22)} ${r.size.padEnd(8)} ${r.lang} ${r.state.padEnd(9)} cq=${r.container ? "y" : "n"} has=${r.has ? "y" : "n"} switches=${r.modebars} nav=${r.nav ? "y" : "n"} locations=${r.locations ? "y" : "n"} headline=${r.tagPx}px  vs reference: ${off.length ? off.join(", ") : "same"}`;
  console.log((r.errors.length ? "FAIL " : "ok   ") + line + (r.errors.length ? `\n       ${r.errors.join("\n       ")}` : ""));
  if (VERBOSE) console.log(`       column: ${r.column.join(" | ")}`);
  if (PROBE) console.log(`       probe: ${JSON.stringify(r.probe)}`);
  if (r.errors.length) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed; screenshots in ${out}`);
process.exit(failed ? 1 : 0);
