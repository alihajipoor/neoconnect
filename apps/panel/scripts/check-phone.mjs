#!/usr/bin/env node
// DEV ONLY: does every panel page fit a phone?
//
// Builds the panel (unless --no-build), starts it with `next start` against
// the stand-in API (scripts/standin-api.mjs: invented data only, nothing
// leaves the machine), and drives a headless Chrome over the DevTools
// protocol -- the same approach as apps/mobile's `check:phone-fit`. For
// every route the signed-in role can open, at each size, it fails when:
//   - the page scrolls sideways (the document is wider than the screen);
//   - anything outside a scroll area is wider than the screen, or pokes
//     past its edge;
//   - something is cut off: content clipped by an overflow-hidden box
//     (text that ellipsizes on purpose -- `truncate` -- is not a failure);
//   - the page errored, or sent the session to /login;
//   - under 640px, a list that uses stacked rows (`<Table stack>`) scrolls
//     sideways at all, or a row's status or actions button is not wholly
//     on the screen. (Comparison tables -- `stickyFirst` or plain -- may
//     scroll sideways inside their own box.)
// On /settings/account it also renders two-factor off (no Trusted devices
// card); on /login it signs in to the code step (the stand-in always asks
// for one) and checks the "Trust this device" box is on the screen and a
// full tap target tall.
// Then it opens the main things a page opens -- the phone menu, each
// "New ..." dialog, the first row's actions menu and its Edit dialog --
// and checks they sit inside the screen, fit it sideways, and that every
// button in a dialog can be scrolled into view.
// Reported, not failed: inputs under 16px text (iPhone zooms on focus) and
// tap targets under 32px, at phone widths.
//
// A full-page screenshot per route and size, and one per opened dialog or
// menu, lands in --out (default: <main checkout>/.claude/reviews/panel-mobile/after).
//
//   node scripts/check-phone.mjs [--no-build] [--sizes 360x740,390x844]
//        [--desktop] [--routes /customers,/plans] [--role admin|reseller]
//        [--empty] [--no-open] [--out dir] [--json file] [--chrome path]
//        [--report-only]
//
// --desktop      measures at 1280x800 instead (for before/after comparison).
// --empty        also renders every route with every list empty.
// --report-only  exits 0 even when something fails.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStandin, TRUSTED_THIS_DEVICE } from "./standin-api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const panelDir = path.resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function mainCheckout() {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: panelDir, encoding: "utf8" }).trim();
    return path.dirname(common);
  } catch {
    return path.resolve(panelDir, "../..");
  }
}

const SIZES = (opt("sizes") ?? (flag("desktop") ? "1280x800" : "360x740,390x844"))
  .split(",")
  .map((s) => s.trim().split("x").map(Number))
  .map(([width, height]) => ({ width, height, phone: width < 768 }));
const OUT = path.resolve(opt("out") ?? path.join(mainCheckout(), ".claude/reviews/panel-mobile", flag("desktop") ? "desktop" : "after"));
// Leading slash optional: Git Bash rewrites "/overview" into a Windows path,
// so "overview,customers" is the portable spelling.
const ONLY = opt("routes")?.split(",").map((r) => "/" + r.trim().replace(/^.*\/Git\//, "").replace(/^\/+/, ""));
const ONLY_ROLE = opt("role");
const OPEN = !flag("no-open");

/** Stand-in ids for the [id] routes; standin-api.mjs answers any id. */
const CUSTOMER_ID = "cus_standin_0001";
const TICKET_ID = "tkt_standin_open_0001";

const ADMIN_ROUTES = [
  "/overview",
  "/customers",
  `/customers/${CUSTOMER_ID}`,
  "/monitor",
  "/plans",
  "/nodes",
  "/protocol-configs",
  "/routes",
  "/gaming",
  "/invoices",
  "/vouchers",
  "/support",
  `/support/${TICKET_ID}`,
  "/client-attempts",
  "/reachability",
  "/block-watch",
  "/isp-recommendations",
  "/announcements",
  "/admins",
  "/reseller",
  "/resellers",
  "/settings/account",
  "/settings/payments",
  "/settings/email",
  "/settings/trial",
  "/settings/referrals",
  "/settings/links",
  "/settings/support",
  "/settings/relay",
];
/** A reseller sees two pages (sidebar-nav.tsx RESELLER_ALLOWED). */
const RESELLER_ROUTES = ["/reseller", "/settings/account"];

const ROLES = [
  { name: "admin", sub: "adm_standin_0000", email: "owner@example.com", role: "SUPERADMIN", routes: ADMIN_ROUTES },
  { name: "reseller", sub: "adm_standin_0003", email: "reseller.partner.shop-number-one@example.com", role: "RESELLER", routes: RESELLER_ROUTES },
  { name: "signed-out", routes: ["/login"] },
].filter((r) => !ONLY_ROLE || r.name === ONLY_ROLE);

// ------------------------------------------------------------ plumbing

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

/** Stops a process this script started, and its children, by its pid. */
function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
  } else {
    child.kill("SIGTERM");
  }
}

/** An unsigned token: the panel only decodes it (src/lib/session.ts), and
 * the stand-in API never checks it. */
function standinToken({ sub, email, role }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub, email, role, exp })}.standin`;
}

const slug = (route) => route.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-") || "root";

// ------------------------------------------------------- in-page probes

/** Runs in the page. `scope` is a selector to measure inside (a dialog),
 * or null for the whole document. Returns problems and notes. */
const MEASURE = (scopeSel, phone) => `(() => {
  const W = document.documentElement.clientWidth;
  const H = window.innerHeight;
  const problems = [];
  const notes = [];
  const scope = ${JSON.stringify(scopeSel)} ? [...document.querySelectorAll(${JSON.stringify(scopeSel)})].pop() : document.body;
  if (!scope) return { problems: ['nothing to measure: ' + ${JSON.stringify(scopeSel)} + ' not found'], notes };
  if (!${JSON.stringify(scopeSel)}) {
    const sw = document.scrollingElement.scrollWidth;
    if (sw > W + 1) problems.push('page scrolls sideways: ' + sw + 'px wide on a ' + W + 'px screen');
  }
  const describe = (el) => {
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).slice(0, 6).join('.');
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 50);
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (text ? ' "' + text + '"' : '');
  };
  const visible = (el, s) => {
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const srOnly = (s, r) => (s.position === 'absolute' && r.width <= 1 && r.height <= 1) || s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)';
  const reported = new Set();
  const underReported = (el) => { for (let p = el.parentElement; p; p = p.parentElement) if (reported.has(p)) return true; return false; };
  const all = [scope, ...scope.querySelectorAll('*')];
  for (const el of all) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const s = getComputedStyle(el);
    if (!visible(el, s)) continue;
    const r = el.getBoundingClientRect();
    if (srOnly(s, r)) continue;
    // Nearest ancestor that clips sideways.
    let clipper = null;
    // Not body: an open dialog locks the page's scroll by setting
    // overflow hidden on it, which is not a box the content is cut by.
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX !== 'visible') { clipper = p; break; }
    }
    const inScroller = clipper && /auto|scroll/.test(getComputedStyle(clipper).overflowX);
    if (!inScroller) {
      if ((r.right > W + 1 || r.left < -1) && !underReported(el)) {
        problems.push('wider than the screen: ' + describe(el) + ' spans ' + Math.round(r.left) + '..' + Math.round(r.right) + 'px');
        reported.add(el);
        continue;
      }
      if (clipper && !underReported(el)) {
        const c = clipper.getBoundingClientRect();
        const cs = getComputedStyle(clipper);
        const clippedText = cs.textOverflow === 'ellipsis' || s.textOverflow === 'ellipsis';
        if (!clippedText && (r.right > c.right + 1 || r.left < c.left - 1) && el.childElementCount === 0 && (el.innerText || '').trim()) {
          problems.push('cut off: ' + describe(el) + ' inside ' + describe(clipper));
          reported.add(el);
          continue;
        }
      }
    }
    // A box that scrolls sideways must say it means to: [data-scroll-x]
    // (the shared table's container carries it). A form or list that only
    // meant to scroll down computes overflow-x auto too, and sliding it
    // sideways on a phone is the bug this looks for.
    if (/auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1 && !el.closest('[data-scroll-x],[data-slot=table-container]') && !underReported(el)) {
      problems.push('scrolls sideways (not a declared scroll area): ' + describe(el) + ' holds ' + el.scrollWidth + 'px in ' + el.clientWidth + 'px');
      reported.add(el);
    }
    // A box that clips its own text sideways without saying so.
    if (s.overflowX === 'hidden' || s.overflowX === 'clip') {
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (ownText && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis' && !underReported(el)) {
        problems.push('cut off: ' + describe(el) + ' holds ' + el.scrollWidth + 'px in ' + el.clientWidth + 'px');
        reported.add(el);
      }
    }
    if (${phone}) {
      const tag = el.tagName.toLowerCase();
      const interactive = tag === 'button' || tag === 'a' || tag === 'select' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'combobox' || (tag === 'input' && !['hidden', 'checkbox', 'radio'].includes(el.type));
      if ((tag === 'input' && !['hidden', 'checkbox', 'radio', 'submit', 'button'].includes(el.type)) || tag === 'textarea' || tag === 'select') {
        if (parseFloat(s.fontSize) < 16) notes.push('input text ' + s.fontSize + ' (iPhone zooms under 16px): ' + describe(el));
      }
      if (interactive && (r.height < 32 || r.width < 32) && !(tag === 'a' && s.display === 'inline')) notes.push('small tap target ' + Math.round(r.width) + 'x' + Math.round(r.height) + ': ' + describe(el));
    }
  }
  if (${JSON.stringify(scopeSel)}) {
    const r = scope.getBoundingClientRect();
    if (r.left < -1 || r.right > W + 1 || r.top < -1 || r.bottom > H + 1) problems.push('not inside the screen: ' + describe(scope).slice(0, 60) + ' at ' + Math.round(r.left) + ',' + Math.round(r.top) + '..' + Math.round(r.right) + ',' + Math.round(r.bottom));
    // Every button can be brought on screen and is not under anything.
    for (const b of scope.querySelectorAll('button, a[href], [role=menuitem]')) {
      const bs = getComputedStyle(b);
      if (!visible(b, bs) || srOnly(bs, b.getBoundingClientRect())) continue;
      // Centre, not nearest: nearest parks it under a sticky dialog footer,
      // where a person would simply scroll a little further.
      b.scrollIntoView({ block: 'center', inline: 'nearest' });
      const br = b.getBoundingClientRect();
      const cx = br.left + br.width / 2, cy = br.top + br.height / 2;
      const onScreen = br.left >= -1 && br.right <= W + 1 && br.top >= -1 && br.bottom <= H + 1;
      const hit = onScreen && document.elementFromPoint(cx, cy);
      if (!onScreen || !hit || !(b === hit || b.contains(hit))) problems.push('button not reachable: ' + describe(b));
    }
  }
  return { problems: [...new Set(problems)], notes: [...new Set(notes)] };
})()`;

/** Runs in the page under 640px. Every table that opted into stacked rows
 * (`<Table stack>`, table[data-stack]) must not scroll sideways at all,
 * and every row's status and actions button must be on the screen, whole.
 * Rows taller than 300px are noted (not failed): a stacked row is meant to
 * be a few lines. */
const STACKED = `(() => {
  const W = document.documentElement.clientWidth;
  const problems = [];
  const notes = [];
  const tables = [...document.querySelectorAll('table[data-stack]')];
  const label = (t, i) => {
    const h = t.closest('section, [data-slot=card], main')?.querySelector('h1, h2, [data-slot=card-title]');
    return 'stacked table ' + (i + 1) + (h ? ' ("' + h.innerText.trim().slice(0, 30) + '")' : '');
  };
  tables.forEach((t, i) => {
    const box = t.closest('[data-slot=table-container]');
    if (box && box.scrollWidth > box.clientWidth + 1) problems.push(label(t, i) + ' scrolls sideways: ' + box.scrollWidth + 'px in ' + box.clientWidth + 'px');
    if (t.getBoundingClientRect().right > W + 1) problems.push(label(t, i) + ' is wider than the screen');
    [...t.tBodies].flatMap((b) => [...b.rows]).forEach((tr, r) => {
      for (const kind of ['status', 'actions']) {
        const td = tr.querySelector(':scope > td[data-cell=' + kind + ']');
        if (!td || getComputedStyle(td).display === 'none') continue;
        const el = kind === 'actions' ? (td.querySelector('button, a') ?? td) : td;
        const rr = el.getBoundingClientRect();
        if (rr.width === 0 && rr.height === 0) continue;
        if (rr.left < -1 || rr.right > W + 1) problems.push(label(t, i) + ' row ' + (r + 1) + ': ' + kind + ' outside the screen (' + Math.round(rr.left) + '..' + Math.round(rr.right) + 'px)');
      }
      const h = tr.getBoundingClientRect().height;
      if (h > 300) notes.push(label(t, i) + ' row ' + (r + 1) + ' is ' + Math.round(h) + 'px tall');
    });
    // The first row's "More" shows what it folds away, and folds it back.
    const toggle = t.querySelector('td[data-cell=more] input[data-more-toggle]');
    if (toggle) {
      const tr = toggle.closest('tr');
      const folded = () => [...tr.querySelectorAll(':scope > td[data-more]')].filter((td) => getComputedStyle(td).display !== 'none').length;
      const before = folded();
      toggle.click();
      const opened = folded();
      toggle.click();
      if (before !== 0 || opened === 0 || folded() !== 0) problems.push(label(t, i) + ': More does not show and hide the folded facts (' + before + ' -> ' + opened + ' -> ' + folded() + ')');
    }
  });
  return { tables: tables.length, problems, notes };
})()`;

const PAGE_STATE = `(() => {
  const text = document.body ? document.body.innerText : '';
  const errored = /Application error|This page couldn.t load|Something went wrong|Unhandled Runtime Error|Internal Server Error|404: This page could not be found/i.test(text);
  return { path: location.pathname, errored, text: errored ? text.slice(0, 300) : '' };
})()`;

// ---------------------------------------------------------------- main

const results = [];
let standin;
let nextProc;
let chrome;
let ws;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nx-panel-phone-"));

try {
  if (!flag("no-build")) {
    console.log("Building the panel (next build)...");
    execFileSync(process.execPath, [path.join(panelDir, "node_modules/next/dist/bin/next"), "build"], {
      cwd: panelDir,
      stdio: "inherit",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
  }
  const apiPort = await freePort();
  standin = await startStandin({ port: apiPort });
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  nextProc = spawn(process.execPath, [path.join(panelDir, "node_modules/next/dist/bin/next"), "start", "-p", String(appPort), "-H", "127.0.0.1"], {
    cwd: panelDir,
    env: { ...process.env, INTERNAL_API_URL: `http://127.0.0.1:${apiPort}`, NEXT_TELEMETRY_DISABLED: "1", PORT: String(appPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let nextLog = "";
  nextProc.stdout.on("data", (d) => (nextLog += d));
  nextProc.stderr.on("data", (d) => (nextLog += d));
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${base}/login`);
      if (res.status < 500) break;
    } catch {
      // not up yet
    }
    if (i > 120 || nextProc.exitCode !== null) throw new Error(`next start did not come up:\n${nextLog.slice(-2000)}`);
    await sleep(500);
  }

  const cdpPort = await freePort();
  chrome = spawn(chromePath(), ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method) {
      for (const w of [...waiters]) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m.params); }
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const waitFor = (method, ms = 20000) =>
    Promise.race([new Promise((resolve) => waiters.push({ method, resolve })), sleep(ms).then(() => null)]);
  const ev = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 500));
    return res.result?.result?.value;
  };
  const shot = async (file, full) => {
    const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!full });
    if (res.result?.data) fs.writeFileSync(path.join(OUT, file), Buffer.from(res.result.data, "base64"));
  };
  /** A real pointer press and release at the element's centre: Radix menus
   * open on pointerdown, which el.click() never sends. */
  const press = async (selectorJs) => {
    const c = await ev(`(() => { const el = ${selectorJs}; if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    if (!c) return false;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: c.x, y: c.y, button: "left", clickCount: 1, pointerType: "mouse" });
    }
    await sleep(400);
    return true;
  };
  const escape = async () => {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);
  };
  const settle = async () => {
    await ev("document.fonts.ready.then(() => true)").catch(() => {});
    await sleep(250);
  };
  const navigate = async (url) => {
    const loaded = waitFor("Page.loadEventFired");
    await send("Page.navigate", { url });
    await loaded;
    await settle();
  };

  await send("Page.enable");
  await send("Network.enable");
  fs.mkdirSync(OUT, { recursive: true });

  const variants = flag("empty") ? [false, true] : [false];
  for (const empty of variants) {
    await fetch(`http://127.0.0.1:${apiPort}/__variant?empty=${empty ? 1 : 0}`);
    for (const role of ROLES) {
      await send("Network.clearBrowserCookies");
      if (role.role) {
        await send("Network.setCookie", { name: "neoxify_access", value: standinToken(role), url: base, path: "/" });
        // Marks one stand-in trusted device as this browser's.
        await send("Network.setCookie", { name: "neoxify_trusted_id", value: TRUSTED_THIS_DEVICE, url: base, path: "/" });
      }
      for (const route of role.routes.filter((r) => !ONLY || ONLY.includes(r))) {
        for (const size of SIZES) {
          await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.phone });
          await send("Emulation.setTouchEmulationEnabled", { enabled: false });
          const tag = `${role.name}${empty ? "-empty" : ""}-${slug(route)}-${size.width}x${size.height}`;
          const row = { role: role.name, empty, route, size: `${size.width}x${size.height}`, problems: [], notes: [], opened: [] };
          results.push(row);
          await navigate(base + route);
          const st = await ev(PAGE_STATE);
          if (st.errored) row.problems.push(`page errored: ${st.text.replace(/\s+/g, " ").slice(0, 200)}`);
          if (st.path !== route) row.problems.push(`landed on ${st.path} instead`);
          const m = await ev(MEASURE(null, size.phone));
          row.problems.push(...m.problems);
          row.notes.push(...m.notes);
          if (size.width < 640) {
            const st2 = await ev(STACKED);
            row.stacked = st2.tables;
            row.problems.push(...st2.problems);
            row.notes.push(...st2.notes);
          }
          await shot(`${tag}.png`, true);

          // Settings > Account with two-factor off: no Trusted devices card.
          if (route === "/settings/account" && !empty) {
            await fetch(`http://127.0.0.1:${apiPort}/__variant?mfa=0`);
            await navigate(base + route);
            const off = await ev(MEASURE(null, size.phone));
            row.problems.push(...off.problems.map((p) => `2FA off: ${p}`));
            row.notes.push(...off.notes.map((p) => `2FA off: ${p}`));
            if (await ev(`[...document.querySelectorAll('[data-slot=card-title]')].some(t => t.innerText.trim() === 'Trusted devices')`)) row.problems.push("2FA off: Trusted devices card still shown");
            row.opened.push("2fa-off");
            await shot(`${tag}--2fa-off.png`, true);
            await fetch(`http://127.0.0.1:${apiPort}/__variant?mfa=1`);
            await navigate(base + route);
          }

          // Sign-in to the code step, where "Trust this device" sits.
          if (route === "/login" && !empty) {
            await ev(`(() => {
              const set = (id, v) => { const el = document.getElementById(id); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
              set('email', 'owner@example.com');
              set('password', 'stand-in-password');
              return true;
            })()`);
            await press(`document.querySelector('form button[type=submit]')`);
            for (let i = 0; i < 50 && !(await ev(`!!document.getElementById('trustDevice')`)); i++) await sleep(200);
            const box = await ev(`(() => {
              const cb = document.getElementById('trustDevice');
              if (!cb) return null;
              const r = cb.closest('label').getBoundingClientRect();
              return { left: r.left, right: r.right, height: r.height, W: document.documentElement.clientWidth };
            })()`);
            if (!box) row.problems.push("code step: never reached (no Trust this device box)");
            else {
              const cm = await ev(MEASURE(null, size.phone));
              row.problems.push(...cm.problems.map((p) => `code step: ${p}`));
              row.notes.push(...cm.notes.map((p) => `code step: ${p}`));
              if (box.left < -1 || box.right > box.W + 1) row.problems.push(`code step: Trust this device outside the screen (${Math.round(box.left)}..${Math.round(box.right)}px)`);
              if (box.height < 40) row.problems.push(`code step: Trust this device row only ${Math.round(box.height)}px tall`);
              row.opened.push("code-step");
              await shot(`${tag}--code-step.png`, true);
            }
            await navigate(base + route);
          }
          if (!OPEN || empty) continue;

          // The things a page opens.
          const opens = [];
          opens.push({ name: "menu", trigger: `document.querySelector('button[aria-label="Open menu"]')`, scope: '[role=dialog]' });
          const newButtons = await ev(`[...document.querySelectorAll('main button')].filter(b => /^\\s*New\\b/.test(b.innerText) && b.offsetParent).map(b => b.innerText.trim())`);
          for (const text of newButtons ?? []) {
            opens.push({ name: slug(text.toLowerCase()), trigger: `[...document.querySelectorAll('main button')].find(b => b.innerText.trim() === ${JSON.stringify(text)})`, scope: "[role=dialog]" });
          }
          opens.push({ name: "row-actions", trigger: `document.querySelector('main button[aria-label="Row actions"]')`, scope: "[role=menu]", then: { name: "edit", trigger: `[...document.querySelectorAll('[role=menuitem]')].find(i => i.innerText.trim() === 'Edit')`, scope: "[role=dialog]" } });
          for (const o of opens) {
            const did = await press(o.trigger);
            if (!did) continue;
            const open = await ev(`!!document.querySelector(${JSON.stringify(o.scope)})`);
            if (!open) {
              row.problems.push(`${o.name}: pressed, nothing opened`);
              continue;
            }
            await sleep(250);
            const om = await ev(MEASURE(o.scope, size.phone));
            row.opened.push(o.name);
            row.problems.push(...om.problems.map((p) => `${o.name}: ${p}`));
            row.notes.push(...om.notes.map((p) => `${o.name}: ${p}`));
            await shot(`${tag}--${o.name}.png`, false);
            if (o.then && (await press(o.then.trigger))) {
              await sleep(500);
              if (await ev(`!!document.querySelector(${JSON.stringify(o.then.scope)})`)) {
                const tm = await ev(MEASURE(o.then.scope, size.phone));
                row.opened.push(o.then.name);
                row.problems.push(...tm.problems.map((p) => `${o.then.name}: ${p}`));
                row.notes.push(...tm.notes.map((p) => `${o.then.name}: ${p}`));
                await shot(`${tag}--${o.then.name}.png`, false);
              }
              await escape();
            }
            await escape();
            await escape();
            if (await ev(`!!document.querySelector('[role=dialog],[role=menu],[role=alertdialog]')`)) {
              row.problems.push(`${o.name}: still open after Escape`);
              await navigate(base + route);
            }
            // Once per role: choosing a page in the phone menu goes there and
            // closes the menu; the page's own entry is marked current.
            if (o.name === "menu" && route === role.routes[0] && size === SIZES[0]) {
              await press(o.trigger);
              const current = await ev(`(() => { const a = document.querySelector('[role=dialog] a[aria-current=page]'); return a ? a.getAttribute('href') : null; })()`);
              if (!current || !route.startsWith(current)) row.problems.push(`menu: current page not marked (got ${current})`);
              const target = role.routes.find((r) => r !== route && !r.includes("standin"));
              const targetHref = await ev(`(() => { const want = ${JSON.stringify(target)}; const links = [...document.querySelectorAll('[role=dialog] a[href]')].map(a => a.getAttribute('href')); return links.find(h => want.startsWith(h)) ?? null; })()`);
              if (targetHref && (await press(`document.querySelector('[role=dialog] a[href="${targetHref}"]')`))) {
                for (let i = 0; i < 40 && !(await ev(`location.pathname.startsWith(${JSON.stringify(targetHref)})`)); i++) await sleep(100);
                await sleep(400);
                const after = await ev(`({ path: location.pathname, open: !!document.querySelector('[role=dialog]') })`);
                if (!after.path.startsWith(targetHref)) row.problems.push(`menu: choosing ${targetHref} landed on ${after.path}`);
                if (after.open) row.problems.push(`menu: still open after choosing ${targetHref}`);
                row.opened.push("menu-navigate");
              } else if (target) {
                row.problems.push(`menu: no link to ${target}`);
              }
              await navigate(base + route);
            }
          }
        }
      }
    }
  }
} finally {
  ws?.close();
  stop(chrome);
  stop(nextProc);
  standin?.close();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a lock for a moment; the folder is in the OS temp.
  }
}

// --------------------------------------------------------------- report

let failed = 0;
const byRoute = new Map();
for (const r of results) {
  const key = `${r.role}${r.empty ? " (empty)" : ""} ${r.route}`;
  if (!byRoute.has(key)) byRoute.set(key, []);
  byRoute.get(key).push(r);
}
for (const [key, rows] of byRoute) {
  const bad = rows.filter((r) => r.problems.length);
  const notes = new Set(rows.flatMap((r) => r.notes));
  console.log(`${bad.length ? "FAIL" : "ok  "} ${key}${rows[0].opened.length ? `  [opened: ${rows[0].opened.join(", ")}]` : ""}${notes.size ? `  (${notes.size} notes)` : ""}`);
  for (const r of bad) {
    failed++;
    for (const p of r.problems.slice(0, 8)) console.log(`       ${r.size}  ${p}`);
    if (r.problems.length > 8) console.log(`       ${r.size}  ... and ${r.problems.length - 8} more`);
  }
}
const json = opt("json") ?? path.join(OUT, "results.json");
fs.writeFileSync(json, JSON.stringify(results, null, 2));
console.log(`\n${byRoute.size} routes, ${results.length} renders, ${failed} failing. Screenshots and results.json in ${OUT}`);
process.exit(failed && !flag("report-only") ? 1 : 0);
