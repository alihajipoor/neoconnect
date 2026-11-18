import { load, type Store } from "@tauri-apps/plugin-store";

/** Whether the customer has been told, in the app, what the fuller
 * diagnostics carry (docs/client-diagnostics.md, Rollout 2): the device
 * and its network settings, rung times, the service check.
 *
 * Until they have, every report goes as it did before that change -- no
 * `details`, no rung `ms` (attempts.ts) -- and no service check is
 * reported or run by itself (service-check.ts). A bundle the customer
 * sends from the Support screen is not held by this: they see exactly
 * what it carries before they press Send.
 *
 * Fails closed: a store that cannot be read is "not told".
 *
 * On a phone the notice is the prominent disclosure every customer accepts
 * before the app opens (apps/mobile ProminentDisclosure, version 2 and
 * later), which the phone app sets as the source here. On Windows and
 * Linux it is the desktop notice below (`DiagnosticsNotice` on the
 * Dashboard). */

let source: () => Promise<boolean> = hasAcceptedDesktopNotice;
let known = false;

/** Where the answer comes from: the phone app's disclosure, in its place. */
export function setDiagnosticsConsentSource(read: () => Promise<boolean>): void {
  source = read;
  known = false;
}

/** Never rejects. Once true, true for the run: an acceptance is not taken
 * back. */
export async function diagnosticsAllowed(): Promise<boolean> {
  if (known) return true;
  try {
    known = (await source()) === true;
  } catch {
    known = false;
  }
  return known;
}

/* ------------------------------------------------------------------ *
 * The desktop notice's acceptance, in a file of its own: it is about the
 * app, not an account, so it survives a sign-out.
 * ------------------------------------------------------------------ */

const STORE_FILE = "diagnostics-notice.json";
const KEY = "acceptedVersion";

/** Bumped when what the notice describes gains a new kind of data. */
export const DESKTOP_NOTICE_VERSION = 1;

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

export async function hasAcceptedDesktopNotice(): Promise<boolean> {
  try {
    const accepted = await (await getStore()).get<number>(KEY);
    return typeof accepted === "number" && accepted >= DESKTOP_NOTICE_VERSION;
  } catch {
    return false;
  }
}

/** Recorded, and in force for this run whether or not the write lands (a
 * failed write shows the notice again next start, the safe direction). */
export async function acceptDesktopNotice(): Promise<void> {
  if (source === hasAcceptedDesktopNotice) known = true;
  try {
    const store = await getStore();
    await store.set(KEY, DESKTOP_NOTICE_VERSION);
    await store.save();
  } catch {
    // Shown again next start.
  }
}

export function resetDiagnosticsConsentForTests(read?: () => Promise<boolean>): void {
  source = read ?? hasAcceptedDesktopNotice;
  known = false;
  storePromise = null;
}
