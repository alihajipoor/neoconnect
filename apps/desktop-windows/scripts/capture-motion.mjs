#!/usr/bin/env node
// DEV ONLY: frame strips (and short videos) of the app's key transitions.
//
// Starts the dev preview (preview.html, served by Vite with the account
// samples, NX_PREVIEW_MOCKS=1), drives a headless Chrome over the DevTools
// protocol, and for each transition below presses what a customer would
// press, then holds every animation on the page -- CSS, the Web Animations
// the app plays in script, a view transition's -- and steps them through
// their time together, a screenshot at each step. So the frames are the
// animation's own, not whatever a busy machine managed to catch; the cost is
// that it says nothing about frame rate, which needs a real device.
//
// Each transition gives:
//   <name>.png   the frames side by side, each marked with its time;
//   <name>.anim.png  the same frames played back at their own pace (an animated
//                PNG: any browser plays it).
// The page is never left to a timer during a capture: an exit's timer
// (lib/motion.ts usePresence) is slowed while its frames are taken.
// Nothing leaves the machine: the preview answers every call itself.
//
//   node scripts/capture-motion.mjs --out <dir> [--only name,name] [--chrome path]
//   node scripts/capture-motion.mjs --fps [--only name,name]   (frame timing, this machine only)
//   node scripts/capture-motion.mjs --probe <js> [--size label] [--screen s] [--scenario s] [--lang en|fa]

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = path.resolve(here, "..");
const out = path.resolve(opt("out") ?? path.join(os.tmpdir(), "nx-motion"));
const only = opt("only")?.split(",") ?? null;
fs.mkdirSync(out, { recursive: true });

// The account samples, so the pages have something to show.
process.env.NX_PREVIEW_MOCKS = "1";
const { createServer } = await import("vite");

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

/** An animated PNG from same-sized PNG screenshots: the first frame's
 * header, then each frame's image data under a frame control naming how
 * long it shows -- the gap to the next frame's time, the first and the last
 * held longer so the change can be seen. */
function apng(frames) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const parse = (png) => {
    const chunks = [];
    for (let at = 8; at < png.length; ) {
      const len = png.readUInt32BE(at);
      chunks.push({ type: png.toString("ascii", at + 4, at + 8), data: png.subarray(at + 8, at + 8 + len) });
      at += 12 + len;
    }
    return chunks;
  };
  const pngs = frames.map((f) => parse(Buffer.from(f.data, "base64")));
  const ihdr = pngs[0].find((c) => c.type === "IHDR").data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(0, 4);
  parts.push(chunk("acTL", actl));
  let seq = 0;
  frames.forEach((f, i) => {
    const ms = i === 0 ? 500 : i + 1 < frames.length ? frames[i + 1].t - f.t : 1200;
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt16BE(Math.max(10, i === 0 ? 500 : ms), 20);
    fctl.writeUInt16BE(1000, 22);
    parts.push(chunk("fcTL", fctl));
    for (const c of pngs[i].filter((c) => c.type === "IDAT")) {
      if (i === 0) parts.push(chunk("IDAT", c.data));
      else {
        const n = Buffer.alloc(4);
        n.writeUInt32BE(seq++, 0);
        parts.push(chunk("fdAT", Buffer.concat([n, c.data])));
      }
    }
  });
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Installed before the page's own scripts: timers started while
 * `__nxSlow` is set wait twenty times longer, so an exit is still on screen
 * for every frame of it. */
const SLOW_TIMERS = `(() => {
  const real = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) => real(fn, window.__nxSlow && ms >= 100 && ms <= 400 ? ms * 20 : ms, ...rest);
})();`;

/** Presses `trigger`, waits for what it set moving -- a view transition
 * starts a frame or two later -- then holds every animation. */
const ARM = (trigger) => `(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const finite = () => document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity);
  const before = new Set(document.getAnimations());
  ${trigger};
  let fresh = [];
  for (let i = 0; i < 30; i++) {
    await raf();
    fresh = finite().filter((a) => !before.has(a));
    if (fresh.length > 0) break;
  }
  // Late starters: a view transition's new state, a stagger's next rows.
  await raf();
  await raf();
  // Only what the press started: an earlier entrance that has finished but
  // holds its end frame is still "in effect", and seeking it would replay it.
  const held = document.getAnimations().filter((a) => !before.has(a));
  for (const a of held) {
    try { a.pause(); } catch {}
  }
  window.__nxHeld = held;
  return { count: held.length, fresh: fresh.length, vt: held.some((a) => String(a.effect?.pseudoElement ?? '').includes('view-transition')) };
})()`;

const SEEK = (t) => `(() => {
  for (const a of window.__nxHeld ?? []) {
    try { a.currentTime = ${t}; } catch {}
  }
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
})()`;

const RELEASE = `(() => {
  for (const a of window.__nxHeld ?? []) {
    try {
      if (a.effect && a.effect.getTiming().iterations === Infinity) a.play();
      else a.finish();
    } catch {}
  }
  window.__nxHeld = [];
  window.__nxSlow = false;
  return true;
})()`;

const FRAME_RECT = `(() => {
  const b = document.querySelector('[data-testid=frame]').getBoundingClientRect();
  return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height };
})()`;

/** A part of the frame, with a margin, inside the frame: what a
 * transition's `focus` names, so a small change is not lost in a large
 * window. */
const FOCUS_RECT = (selector, pad = 12) => `(() => {
  const f = document.querySelector('[data-testid=frame]').getBoundingClientRect();
  const el = document.querySelector('[data-testid=frame] ${selector}');
  if (!el) return null;
  const b = el.getBoundingClientRect();
  const x0 = Math.max(f.left, b.left - ${pad}), y0 = Math.max(f.top, b.top - ${pad});
  const x1 = Math.min(f.right, b.right + ${pad}), y1 = Math.min(f.bottom, b.bottom + ${pad});
  return { x: x0 + scrollX, y: y0 + scrollY, width: x1 - x0, height: y1 - y0 };
})()`;

/** Clicks the first element matching `selector` whose text contains
 * `text` (when given), inside the preview's frame. */
const click = (selector, text) => `(() => {
  const els = [...document.querySelectorAll('[data-testid=frame] ${selector}')];
  const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : "els[0]"};
  if (!el) throw new Error('nothing to press: ${selector} ${text ?? ""}');
  el.click();
})()`;

/** Types into a React-controlled field. */
const type = (selector, value) => `(() => {
  const el = document.querySelector('[data-testid=frame] ${selector}');
  if (!el) throw new Error('no field: ${selector}');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

const steps = (to, by) => Array.from({ length: Math.floor(to / by) + 1 }, (_, i) => i * by);

/** The transitions: where to start, what to press, and when to look. */
const DESKTOP = "1180 × 760 (first launch)";
const PHONE = "390 × 844 (phone)";
const TRANSITIONS = [
  {
    name: "01-first-look-main",
    note: "The main page's first look of a session: the copy column top to bottom, then the panel and the tray, the list's rows.",
    setup: { size: DESKTOP, screen: "main", scenario: "connected" },
    trigger: `document.querySelector('[data-testid=replay]').click()`,
    times: steps(960, 80),
  },
  {
    name: "02-nav-main-to-settings",
    note: "Sidebar: Overview to Settings. The page slides in from the inline end, the selected pill travels, Settings' groups rise in order (first view).",
    setup: { size: DESKTOP, screen: "main", scenario: "connected" },
    trigger: click(".nx-side .nx-nav button", "Settings"),
    times: steps(840, 70),
  },
  {
    name: "03-nav-settings-to-activity",
    note: "Sidebar: Settings to Activity. The pill travels up; the usage bars grow from the axis the first time.",
    setup: { size: DESKTOP, screen: "settings", scenario: "connected" },
    trigger: click(".nx-side .nx-nav button", "Activity"),
    times: steps(980, 70),
  },
  {
    name: "04-settings-sub-page",
    note: "Settings to one of its pages (Repair my network): forward, from the inline end.",
    setup: { size: DESKTOP, screen: "settings", scenario: "connected", settle: 1500 },
    trigger: click("button.nx-li", "Repair"),
    times: steps(600, 60),
  },
  {
    name: "05-country-open",
    note: "Locations panel: a country opens. Its protocols slide out from under it and the rows after it move down with them -- transform only.",
    setup: { size: DESKTOP, screen: "main", scenario: "idle" },
    focus: ".nx-panel",
    trigger: click(".nx-panel .nx-crow"),
    times: steps(600, 50),
  },
  {
    name: "06-country-close",
    note: "The same country closing: the reverse, and only then taken out of the layout.",
    setup: { size: DESKTOP, screen: "main", scenario: "idle", then: click(".nx-panel .nx-crow"), thenWait: 900 },
    slow: true,
    focus: ".nx-panel",
    trigger: click(".nx-panel .nx-crow"),
    times: steps(400, 40),
  },
  {
    name: "07-search-filter",
    note: "Typing a search: the rows that stay slide up, the ones that went fade where they stood.",
    setup: { size: DESKTOP, screen: "main", scenario: "idle" },
    focus: ".nx-panel",
    trigger: type(".nx-panel .nx-search input", "fi"),
    times: steps(600, 50),
  },
  {
    name: "08-profile-menu",
    note: "The profile menu springs from its trigger.",
    setup: { size: DESKTOP, screen: "main", scenario: "connected" },
    trigger: click(".nx-side .nx-profile"),
    times: steps(560, 40),
  },
  {
    name: "09-dialog-open",
    note: "Sign out asks first: the scrim fades in and the dialog pops.",
    setup: { size: DESKTOP, screen: "main", scenario: "connected", then: click(".nx-side .nx-profile"), thenWait: 700 },
    trigger: `[...document.querySelectorAll('.nx-menu [role=menuitem]')].pop().click()`,
    times: steps(560, 40),
  },
  {
    name: "10-dialog-close",
    note: "Cancel: the dialog shrinks back and the scrim fades -- it leaves the way it came.",
    setup: {
      size: DESKTOP,
      screen: "main",
      scenario: "connected",
      then: `${click(".nx-side .nx-profile")}; setTimeout(() => [...document.querySelectorAll('.nx-menu [role=menuitem]')].pop().click(), 500)`,
      thenWait: 1500,
    },
    slow: true,
    trigger: `document.querySelector('.nx-dlg .nx-btn.ghost').click()`,
    times: steps(240, 30),
  },
  {
    name: "11-connect-pill",
    note: "Not connected to Connecting: the chip's words swap, the pill's label swaps and its width morphs by scale, held at its start; the busy line runs.",
    setup: { size: DESKTOP, screen: "main", scenario: "idle" },
    focus: ".nx-hero-copy",
    trigger: `(() => { const el = document.querySelector('[data-testid=scenario]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'connecting'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    times: steps(480, 40),
  },
  {
    name: "12-details-disclosure",
    note: "The main page's details open under their toggle.",
    setup: { size: DESKTOP, screen: "main", scenario: "connected" },
    focus: ".nx-hero-copy",
    trigger: click(".nx-dtoggle"),
    times: steps(600, 50),
  },
  {
    name: "13-phone-sheet-open",
    note: "Phone: the location card opens the sheet from the bottom edge over its scrim.",
    setup: { size: PHONE, screen: "main", scenario: "connected" },
    trigger: `document.querySelector('[data-testid=sheet]').click()`,
    times: steps(640, 50),
  },
  {
    name: "14-phone-sheet-close",
    note: "Phone: the sheet slides back down and the scrim fades.",
    setup: { size: PHONE, screen: "main", scenario: "connected", then: `document.querySelector('[data-testid=sheet]').click()`, thenWait: 900 },
    slow: true,
    trigger: `document.querySelector('[data-testid=sheet]').click()`,
    times: steps(240, 30),
  },
  {
    name: "15-phone-nav",
    note: "Phone: Home to Activity in the bottom nav. The page slides, the nav keeps still, its pill travels and the new icon lifts.",
    setup: { size: PHONE, screen: "main", scenario: "connected" },
    trigger: click(".nx-mnav button", "Activity"),
    times: steps(840, 70),
  },
  {
    name: "16-skeletons",
    note: "Activity while it is still read: the words say Loading and the skeletons' sheen runs -- only while they are on screen.",
    setup: { size: DESKTOP, screen: "activityLoading", scenario: "connected", replay: true },
    trigger: `document.querySelector('[data-testid=replay]').click()`,
    times: steps(1400, 140),
  },
  {
    name: "17-reduced-motion-nav",
    note: "Reduced motion: the same change of page is a short fade; nothing slides, nothing staggers, the pill moves at once.",
    setup: { size: DESKTOP, screen: "main", scenario: "connected", reduce: true },
    trigger: click(".nx-side .nx-nav button", "Settings"),
    times: steps(240, 30),
  },
  {
    name: "18-persian-nav",
    note: "Persian: the page arrives from the inline end, which is the left.",
    setup: { size: DESKTOP, screen: "main", scenario: "connected", language: "fa" },
    trigger: `[...document.querySelectorAll('[data-testid=frame] .nx-side .nx-nav button')][3].click()`,
    times: steps(840, 70),
  },
];

/** Static looks: no transition, one picture each. */
const STILLS = [
  { name: "19-logo-922x648", note: "The fitted 922x648 window: the glass mark now drawn at 92px (it stepped aside under 96px before).", setup: { size: "922 × 648 (fitted, 1280×720 at 150%)", screen: "main", scenario: "connected" } },
];

const port = await freePort();
const server = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  logLevel: "error",
  server: { port, strictPort: true, host: "127.0.0.1", hmr: false },
});
await server.listen();

const cdpPort = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nx-motion-"));
const chrome = spawn(
  chromePath(),
  ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--window-size=1600,1300", "--autoplay-policy=no-user-gesture-required", "about:blank"],
  { stdio: "ignore" },
);

let ws;
const report = [];
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
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? "exception");
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
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
  const choose = (testid, value) =>
    ev(`(() => {
      const el = document.querySelector('[data-testid="${testid}"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === ${JSON.stringify(value)};
    })()`);
  const shot = async (area) => {
    const clip = area ?? (await ev(FRAME_RECT));
    const res = await send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
    return res.result.data;
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: SLOW_TIMERS });
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1300, deviceScaleFactor: 1, mobile: false });

  /** A fresh page in the start state: every view unseen, as on a launch. */
  async function start(setup) {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: setup.reduce ? "reduce" : "no-preference" }] });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/preview.html` });
    for (let i = 0; i < 80; i++) {
      if (await ev("!!document.querySelector('[data-testid=scenario]')").catch(() => false)) break;
      await sleep(250);
    }
    await ev("document.fonts.ready.then(() => true)");
    await choose("theme", "light");
    await choose("language", setup.language ?? "en");
    await choose("size", setup.size);
    await choose("scenario", setup.scenario);
    await choose("screen", setup.screen);
    // The first entrances and the screen's own arrival, done.
    await sleep(setup.settle ?? 1400);
    if (setup.then) {
      await ev(setup.then);
      await sleep(setup.thenWait ?? 900);
    }
  }

  async function compose(name, note, frames, size) {
    const still = frames.length === 1;
    // About 480px a frame (a phone or a panel nearer its own size), as many
    // to a row as fit 2000px.
    const scale = still ? 1 : Math.min(1, size.width > 700 ? 480 / size.width : 300 / size.width);
    const w = Math.round(size.width * scale);
    const h = Math.round(size.height * scale);
    const perRow = still ? 1 : Math.max(1, Math.floor(2000 / (w + 14)));
    const cells = frames
      .map(
        (f) =>
          `<figure><img src="data:image/png;base64,${f.data}" width="${w}" height="${h}"><figcaption>${f.t} ms</figcaption></figure>`,
      )
      .join("");
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:18px;background:#e7eaf0;font:13px system-ui,sans-serif;color:#1a1f2b;width:${perRow * (w + 14) + 22}px}
      h1{font-size:15px;margin:0 0 4px} p{margin:0 0 12px;max-width:${perRow * (w + 14) - 20}px;color:#4a5264}
      .g{display:grid;grid-template-columns:repeat(${perRow},${w}px);gap:14px}
      figure{margin:0} img{display:block;border-radius:6px;box-shadow:0 0 0 1px rgba(20,30,60,.15)}
      figcaption{margin-top:3px;font-variant-numeric:tabular-nums;color:#4a5264}
</style>
      <h1>${name}</h1><p>${note}</p><div class="g">${cells}</div>`;
    const tree = await send("Page.getFrameTree");
    await send("Page.navigate", { url: "about:blank" });
    await sleep(200);
    await send("Page.setDocumentContent", { frameId: tree.result.frameTree.frame.id, html });
    await ev("Promise.all([...document.images].map((i) => i.decode().catch(() => null))).then(() => true)");
    const dims = await ev("({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })");
    await send("Emulation.setDeviceMetricsOverride", { width: dims.w, height: dims.h, deviceScaleFactor: 1, mobile: false });
    const strip = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(strip.result.data, "base64"));
    // The frames played back at their own pace: an animated PNG made of
    // the screenshots themselves, nothing re-encoded.
    if (frames.length > 1) fs.writeFileSync(path.join(out, `${name}.anim.png`), apng(frames));
    await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1300, deviceScaleFactor: 1, mobile: false });
  }

  // --probe <expression>: evaluate it in a start state and print the
  // answer, for looking into a frame without a transition.
  if (opt("probe")) {
    await start({ size: opt("size") ?? DESKTOP, screen: opt("screen") ?? "main", scenario: opt("scenario") ?? "connected", language: opt("lang") ?? "en" });
    console.log(JSON.stringify(await ev(opt("probe")), null, 1));
    TRANSITIONS.length = 0;
    STILLS.length = 0;
  }
  // --fps: each transition run live instead, its frames timed on this
  // machine's headless Chrome -- an indication, not a device's frame rate.
  if (args.includes("--fps")) {
    for (const tr of TRANSITIONS) {
      if (only && !only.includes(tr.name)) continue;
      await start(tr.setup);
      if (tr.slow) await ev("window.__nxSlow = true");
      const gaps = await ev(`(async () => {
        const gaps = [];
        let last = performance.now();
        let on = true;
        const tick = (t) => { gaps.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
        requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
        await new Promise((r) => setTimeout(r, 100));
        ${tr.trigger};
        await new Promise((r) => setTimeout(r, ${Math.max(...tr.times) + 200}));
        on = false;
        return gaps;
      })()`);
      const sorted = [...gaps].sort((x, y) => x - y);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      const slow = gaps.filter((g) => g > 25).length;
      report.push({ name: tr.name, frames: gaps.length, p50: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1), over25ms: slow });
      console.log(`${tr.name}: ${gaps.length} frames, p50 ${q(0.5).toFixed(1)}ms, p90 ${q(0.9).toFixed(1)}ms, max ${sorted[sorted.length - 1].toFixed(1)}ms, ${slow} over 25ms`);
      await ev("window.__nxSlow = false");
    }
    TRANSITIONS.length = 0;
    STILLS.length = 0;
  }
  for (const tr of TRANSITIONS) {
    if (only && !only.includes(tr.name)) continue;
    errors.length = 0;
    await start(tr.setup);
    if (tr.slow) await ev("window.__nxSlow = true");
    const area = tr.focus ? await ev(FOCUS_RECT(tr.focus)) : null;
    const armed = await ev(ARM(tr.trigger));
    const size = area ?? (await ev(FRAME_RECT));
    const frames = [];
    for (const t of tr.times) {
      await ev(SEEK(t));
      frames.push({ t, data: await shot(area) });
    }
    await ev(RELEASE);
    await compose(tr.name, tr.note, frames, size);
    report.push({ name: tr.name, frames: frames.length, held: armed.count, started: armed.fresh, viewTransition: armed.vt, errors: [...errors] });
    console.log(`${tr.name}: ${frames.length} frames, ${armed.count} animations held${armed.vt ? " (view transition)" : ""}${errors.length ? `, ${errors.length} page errors` : ""}`);
  }
  for (const st of STILLS) {
    if (only && !only.includes(st.name)) continue;
    errors.length = 0;
    await start(st.setup);
    const size = await ev(FRAME_RECT);
    const mark = await ev("(() => { const m = document.querySelector('[data-testid=frame] .nx-mark'); return m ? Math.round(m.getBoundingClientRect().width) : 0; })()");
    const data = await shot();
    await compose(st.name, `${st.note} Measured: the mark is ${mark}px.`, [{ t: 0, data }], size);
    report.push({ name: st.name, mark, errors: [...errors] });
    console.log(`${st.name}: mark ${mark}px`);
  }
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
} finally {
  ws?.close();
  chrome.kill();
  await server.close();
}
