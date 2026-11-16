#!/usr/bin/env node
// Drives the installed Linux app (/usr/bin/neoxify) through its real
// interface over plain WebDriver HTTP, so the customer's path can be checked
// in the test VM without a person at the screen. It is a small command line
// rather than one fixed scenario because each step of the GUI proof depends on
// what the previous screen showed, and a session kept in a state file lets the
// steps run one at a time from the host.
//
// Start the driver first (see `env` below), then for example:
//   node vm-gui-proof.mjs open
//   node vm-gui-proof.mjs shot gui-01-signin
//   node vm-gui-proof.mjs signin < credentials     (line 1 email, line 2 password)
//   node vm-gui-proof.mjs text
//   node vm-gui-proof.mjs click "Settings"
//   node vm-gui-proof.mjs close
//
// The sign-in credentials are only ever read from stdin and typed into the
// form; they are never written to disk, printed, or passed on a command line,
// where they would show in the process list and the shell history.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DRIVER = process.env.NX_DRIVER ?? "http://127.0.0.1:4444";
const APP = process.env.NX_APP ?? "/usr/bin/neoxify";
const SHOTS = process.env.NX_SHOTS ?? join(homedir(), "shots");
const STATE = join(homedir(), ".nx-gui-session");

async function wd(method, path, body) {
  const res = await fetch(DRIVER + path, {
    method,
    headers: { "content-type": "application/json" },
    // WebKitWebDriver rejects a POST without a JSON body, even an empty one.
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const v = json.value ?? {};
    throw new Error(`${method} ${path}: ${res.status} ${v.error ?? ""} ${v.message ?? ""}`);
  }
  return json.value;
}

function session() {
  if (!existsSync(STATE)) throw new Error("no session; run `open` first");
  return readFileSync(STATE, "utf8").trim();
}

const s = (p) => `/session/${session()}${p}`;

async function exec(script, args = []) {
  return wd("POST", s("/execute/sync"), { script, args });
}

// Visible text only, with each line trimmed, so a step can be judged from
// what the customer actually sees rather than from hidden markup.
const VISIBLE_TEXT = `
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const t = n.textContent.replace(/\\s+/g, " ").trim();
    if (!t) continue;
    const el = n.parentElement;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    out.push(t);
  }
  return out.join("\\n");
`;

// Finds the smallest visible clickable element whose own text, aria-label or
// title matches, so "Settings" picks the navigation button and not a page that
// merely contains the word.
const FIND_CLICKABLE = `
  const want = arguments[0].toLowerCase();
  const exact = arguments[1];
  const sel = 'button, a, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="option"], [role="menuitem"], li, label, input[type="checkbox"], input[type="radio"], select';
  const cands = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const texts = [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title")]
      .filter(Boolean).map((t) => t.replace(/\\s+/g, " ").trim().toLowerCase());
    if (texts.some((t) => exact ? t === want : t.includes(want))) cands.push(el);
  }
  // Visible text beats an aria-label, or "Close" on a dialog would pick the
  // window's own close button, which quits the app.
  const shown = (el) => (el.innerText || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const rank = (el) => (exact ? shown(el) === want : shown(el).includes(want)) ? 0 : 1;
  cands.sort((a, b) => rank(a) - rank(b) || shown(a).length - shown(b).length);
  if (cands[0]) cands[0].scrollIntoView({ block: "center" });
  if (cands[0] && arguments[2]) cands[0].click();
  return cands[0] ?? null;
`;

async function elementFrom(value) {
  if (!value) return null;
  const key = Object.keys(value).find((k) => k.startsWith("element-"));
  return key ? value[key] : null;
}

async function click(text, exact = false) {
  const el = await elementFrom(await exec(FIND_CLICKABLE, [text, exact]));
  if (!el) throw new Error(`nothing clickable reads "${text}"`);
  try {
    await wd("POST", s(`/element/${el}/click`));
  } catch (e) {
    // WebKitWebDriver's hit test treats a translucent layer above a dialog
    // or a fading screen as covering the element, although a person's
    // click lands on it. A DOM click reaches the same React handler.
    if (!/intercepted|not interactable/.test(String(e))) throw e;
    await exec(FIND_CLICKABLE, [text, exact, true]);
  }
}

async function shot(name) {
  mkdirSync(SHOTS, { recursive: true });
  const b64 = await wd("GET", s("/screenshot"));
  const file = join(SHOTS, `${name}.png`);
  writeFileSync(file, Buffer.from(b64, "base64"));
  console.log(file);
}

async function find(css) {
  return elementFrom(await wd("POST", s("/element"), { using: "css selector", value: css }));
}

async function typeInto(css, text) {
  const el = await find(css);
  await wd("POST", s(`/element/${el}/clear`)).catch(() => {});
  await wd("POST", s(`/element/${el}/value`), { text });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "open": {
    const v = await wd("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application: APP } } },
    });
    writeFileSync(STATE, v.sessionId);
    console.log("session open");
    break;
  }
  case "close": {
    await wd("DELETE", s("")).catch((e) => console.log(String(e)));
    if (existsSync(STATE)) unlinkSync(STATE);
    console.log("session closed");
    break;
  }
  case "forget": {
    // The app was killed from outside; the driver's session is dead with it.
    if (existsSync(STATE)) unlinkSync(STATE);
    break;
  }
  case "shot":
    await shot(rest[0]);
    break;
  case "text":
    // The account's address is on screen once signed in; keep it out of
    // whatever log this output lands in.
    console.log(String(await exec(VISIBLE_TEXT)).replace(/[^\s@]+@[^\s@]+/g, "<email>"));
    break;
  case "click":
    await click(rest[0], rest[1] === "exact");
    break;
  case "pick": {
    // A protocol row under an expanded location: its first text is the
    // protocol's name, followed by its latency, which changes from run to
    // run, so match on the name alone. "Stealth" must not pick "Stealth Lite".
    const ok = await exec(`
      const want = arguments[0];
      for (const b of document.querySelectorAll("button")) {
        const r = b.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        let n, first = null;
        while ((n = w.nextNode())) { if (n.textContent.trim()) { first = n.textContent.trim(); break; } }
        if (first === want) { b.scrollIntoView({ block: "center" }); b.click(); return true; }
      }
      return false;`, [rest[0]]);
    if (!ok) throw new Error(`no visible protocol row "${rest[0]}"`);
    break;
  }
  case "waitfor": {
    // Waits until a line of visible text reads exactly this, for screens
    // that load or animate in before they can be used.
    const until = Date.now() + Number(rest[1] ?? 60) * 1000;
    for (;;) {
      const lines = String(await exec(VISIBLE_TEXT)).split("\n");
      if (lines.includes(rest[0])) break;
      if (Date.now() > until) throw new Error(`"${rest[0]}" did not appear`);
      await new Promise((r) => setTimeout(r, 500));
    }
    break;
  }
  case "js":
    console.log(JSON.stringify(await exec(rest[0], rest.slice(1)), null, 1).replace(/[^\s@"]+@[^\s@"]+/g, "<email>"));
    break;
  case "size": {
    await wd("POST", s("/window/rect"), { width: Number(rest[0]), height: Number(rest[1]) });
    break;
  }
  case "signin": {
    const [email, password] = (await readStdin()).split(/\r?\n/);
    if (!email || !password) throw new Error("stdin must hold the email and the password, one per line");
    await typeInto('input[type="email"]', email);
    await typeInto('input[type="password"]', password);
    console.log("typed");
    break;
  }
  default:
    console.log("commands: open | close | forget | shot <name> | text | click <text> [exact] | js <script> | size <w> <h> | signin");
    process.exit(2);
}
