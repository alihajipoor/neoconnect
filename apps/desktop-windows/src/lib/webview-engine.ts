import { invoke } from "@tauri-apps/api/core";

/** The Windows web component the app is drawn in (Microsoft Edge WebView2
 * Runtime), so how many customers run an old one is known instead of
 * guessed.
 *
 * Its version is read by Rust at start (src-tauri/src/webview_floor.rs).
 * It goes into the Support diagnostics always, and, when it is older than
 * the stylesheet's full target, as one short note on the first connection
 * report of each app start ("webview 100.0.1185.36"), on the report's
 * existing free-text reason -- the way a report already says the app was
 * in the background. No new field, nothing about the device or the
 * customer beyond the version.
 *
 * Below 105 the app draws its layouts from the build's fallbacks
 * (scripts/old-engine-css.mjs); below 111 colour tints are missing
 * (color-mix). Under 111 is the range worth counting. */
export const NOTE_BELOW_MAJOR = 111;

let versionPromise: Promise<string | null> | null = null;

/** The WebView2 Runtime's version, as Rust read it at start; null when it
 * could not be read (or outside the app). */
export function webviewVersion(): Promise<string | null> {
  versionPromise ??= invoke<unknown>("webview_version").then(
    (v) => (typeof v === "string" ? cleanVersion(v) : null),
    () => null,
  );
  return versionPromise;
}

/** A version's leading digits and dots, at most 40 characters; null when
 * it does not start with a digit. */
export function cleanVersion(text: string): string | null {
  const m = /^\s*(\d[\d.]{0,39})/.exec(text);
  return m ? m[1].replace(/\.+$/, "") : null;
}

/** The Chromium version in a user agent ("Chrome/100.0.4896.75"). */
export function chromiumFromUserAgent(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string | null {
  const m = /\bChrome\/(\d[\d.]*)/.exec(userAgent);
  return m ? cleanVersion(m[1]) : null;
}

/** The major version, or null when there is none. */
export function engineMajor(version: string | null | undefined): number | null {
  if (!version) return null;
  const n = Number.parseInt(version, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The note for a report, when the engine is old enough to count:
 * "webview <version>", the Runtime's own version as Rust read it. Only
 * that: the mobile app shares this file and has no such command, so it
 * never adds one (a phone's web view is not this question). */
export function engineNote(runtime: string | null): string | null {
  const major = engineMajor(runtime);
  if (major === null || major >= NOTE_BELOW_MAJOR) return null;
  return `webview ${runtime}`;
}

let noteTaken = false;

/** The note for the first report of this app start, and null for every
 * report after it. */
export async function takeEngineNote(): Promise<string | null> {
  if (noteTaken) return null;
  noteTaken = true;
  try {
    return engineNote(await webviewVersion());
  } catch {
    return null;
  }
}

/** For tests: as on a fresh start. */
export function resetEngineNoteForTests(): void {
  noteTaken = false;
  versionPromise = null;
}

/** The diagnostics line: "webview2: 100.0.1185.36 (Chromium 100.0.4896.75)". */
export function engineLine(runtime: string | null, chromium: string | null): string {
  const own = runtime ?? "could not be read";
  return chromium ? `webview2: ${own} (Chromium ${chromium})` : `webview2: ${own}`;
}
