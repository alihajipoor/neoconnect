// A headless browser on a string: enough of the DevTools protocol to load
// a page at an exact width and screenshot it.
//
// No dependency on purpose. The repo has no Playwright or Puppeteer, and
// installing one to take a few dozen screenshots would add a browser
// download to every `pnpm install`. Node 22+ ships a WebSocket client, and
// Chrome or Edge is already on any machine that reviews an email.
//
// Why not `chrome --headless --screenshot`: it cannot go narrower than the
// window's minimum width on Windows, cannot emulate dark mode, and cannot
// report what overflowed. The protocol does all three.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.BROWSER_BIN,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function findBrowser() {
  const found = CANDIDATES.find((path) => existsSync(path));
  if (!found) {
    throw new Error("No Chrome or Edge found. Set BROWSER_BIN to a Chromium-based browser.");
  }
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the browser and returns `{ shoot, close }`. */
export async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "nx-email-shots-"));
  const child = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  // The browser writes the port it picked here once it is listening.
  const portFile = join(profile, "DevToolsActivePort");
  let endpoint = null;
  for (let i = 0; i < 100 && !endpoint; i += 1) {
    await sleep(100);
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
      if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
    }
  }
  if (!endpoint) {
    child.kill();
    throw new Error("The browser did not open a DevTools port.");
  }

  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not reach the browser.")), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter.method === message.method && waiter.sessionId === message.sessionId) {
        waiters.splice(i, 1);
        waiter.resolve(message.params);
      }
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject, method });
      socket.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const once = (method, sessionId) => new Promise((resolve) => waiters.push({ method, sessionId, resolve }));

  /**
   * Loads `url` at `width` CSS pixels and returns a PNG of the whole page.
   *
   *   dark         emulate prefers-color-scheme: dark
   *   scale        device pixel ratio (2 for a sharp asset, 1 for a review shot)
   *   transparent  no page background, for cutting a logo out
   *   clip         { x, y, width, height } instead of the whole page
   *
   * Also reports every element that sticks out past the viewport's right
   * or left edge, which is what "it overflows on a phone" means.
   */
  async function shoot(url, { width, height = 800, dark = false, scale = 1, transparent = false, clip } = {}) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    try {
      await send("Page.enable", {}, sessionId);
      await send(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: scale, mobile: false },
        sessionId,
      );
      await send(
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] },
        sessionId,
      );
      if (transparent) {
        await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
      }
      const loaded = once("Page.loadEventFired", sessionId);
      await send("Page.navigate", { url }, sessionId);
      await loaded;
      // Images decode after load; a logo that has not painted yet is a
      // blank square in the shot.
      await send(
        "Runtime.evaluate",
        {
          expression:
            "Promise.all([...document.images].map((i) => i.decode ? i.decode().catch(() => null) : null)).then(() => document.fonts.ready).then(() => true)",
          awaitPromise: true,
        },
        sessionId,
      );

      const { result } = await send(
        "Runtime.evaluate",
        {
          returnByValue: true,
          expression: `(() => {
            const vw = document.documentElement.clientWidth;
            const out = [];
            for (const el of document.body.querySelectorAll("*")) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (r.right > vw + 0.5 || r.left < -0.5) {
                out.push(el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : "") +
                  " [" + Math.round(r.left) + ".." + Math.round(r.right) + " of " + vw + "]");
              }
            }
            // The body, not the document: the document is never shorter than
            // the viewport, and a short email would be shot with a screenful
            // of empty page under it.
            return { overflow: out.slice(0, 6), height: Math.ceil(document.body.getBoundingClientRect().height) };
          })()`,
        },
        sessionId,
      );
      const { overflow, height: pageHeight } = result.value;

      const { data } = await send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
          clip: clip ? { ...clip, scale: 1 } : { x: 0, y: 0, width, height: pageHeight, scale: 1 },
        },
        sessionId,
      );
      return { png: Buffer.from(data, "base64"), overflow, height: pageHeight };
    } finally {
      await send("Target.closeTarget", { targetId }).catch(() => null);
    }
  }

  async function close() {
    try {
      await send("Browser.close");
    } catch {
      child.kill();
    }
    await sleep(300);
    // The profile is a throwaway; a browser still letting go of it is not
    // worth failing over.
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* left for the OS to clear */
    }
  }

  return { shoot, close };
}
