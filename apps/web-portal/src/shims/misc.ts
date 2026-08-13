/**
 * Browser stand-ins for the remaining Tauri modules the shared screens
 * import. Each is aliased individually in vite.config.ts.
 *
 * These exist so the screens can be reused verbatim rather than forked
 * for the web. A fork would mean every future fix landing twice, and
 * one of the two copies eventually not getting it -- the same reasoning
 * that made the Android client import the desktop's screens.
 */

// --- @tauri-apps/plugin-http ------------------------------------------
//
// Tauri's fetch exists to bypass the webview's CORS enforcement. In a
// real browser we cannot bypass anything, so this is the platform's own
// fetch and the backend has to permit the origin -- which it does
// (main.ts creates the app with cors: true).
export const fetch = globalThis.fetch.bind(globalThis);

// --- @tauri-apps/api/core ---------------------------------------------
//
// `invoke` reaches Rust commands: the VPN engine, the split tunnel, the
// privileged service. None of that exists in a browser and none of it
// is reachable from this portal, which manages the account rather than
// the tunnel.
//
// It throws rather than returning a benign empty value on purpose. A
// silent no-op here would let a screen believe it had connected a
// tunnel, and reporting a connection state that was never established
// is the one failure this project treats as unacceptable. Any screen
// that reaches this line is a screen that should not have been routed
// to on the web, and the error says so loudly.
export async function invoke<T>(cmd: string, _args?: unknown): Promise<T> {
  throw new Error(
    `"${cmd}" is a desktop-only command. The web portal manages your account; ` +
      `connecting requires the Neoxify app.`,
  );
}

// --- @tauri-apps/plugin-opener ----------------------------------------
export async function openUrl(url: string): Promise<void> {
  // noopener/noreferrer: without them the opened page gets a handle
  // back to this one through window.opener.
  window.open(url, "_blank", "noopener,noreferrer");
}
export const open = openUrl;

// --- @tauri-apps/plugin-clipboard-manager -----------------------------
export async function writeText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

// --- @tauri-apps/plugin-process ---------------------------------------
export async function relaunch(): Promise<void> {
  window.location.reload();
}
export async function exit(_code?: number): Promise<void> {
  // A web page cannot close itself unless it opened itself. Returning
  // to the marketing site is the closest honest equivalent.
  window.location.href = "/";
}

// --- @tauri-apps/api/app ----------------------------------------------
export async function getVersion(): Promise<string> {
  return __PORTAL_VERSION__;
}

// --- @tauri-apps/plugin-updater ---------------------------------------
//
// A web page is always current -- there is nothing to update and no
// installer to fetch. Reporting "no update available" is accurate here,
// unlike on the desktop where it would be a claim we had checked.
export async function check(): Promise<null> {
  return null;
}
