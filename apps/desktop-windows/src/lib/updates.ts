import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Background update checking, Discord-shaped: find it quietly, fetch
 * it quietly, apply it when the customer is already closing the app.
 *
 * The one hard rule is that an update must never interrupt a live
 * tunnel. Replacing the binaries under a running VPN would drop the
 * connection -- and for someone relying on it to reach anything at
 * all, dropping it without warning is worse than being a version
 * behind. So the download happens whenever, and the install happens
 * only on quit.
 */

/** Checked once shortly after launch, then this often. Long, because a
 * release happens every few days at most and a client that asks hourly
 * is just noise on a censored network. */
const RECHECK_MS = 6 * 60 * 60_000;

/** Not at t=0. Launch already fetches the session, the subscription and
 * the protocol list; the update check is the least urgent of those and
 * should not compete with them for a slow connection. */
const FIRST_CHECK_MS = 20_000;

export type UpdateState =
  | { status: "none" }
  /** Found and downloading. */
  | { status: "downloading"; version: string; percent: number | null }
  /** On disk and verified. Applied when the app next quits. */
  | { status: "ready"; version: string };

/** Held here rather than in React state so it survives navigation
 * between screens -- a download that restarted every time the customer
 * opened Settings would never finish. */
let staged: Update | null = null;
let inFlight = false;

export function stagedUpdate(): Update | null {
  return staged;
}

/** Looks for an update and, if there is one, downloads it.
 *
 * Silent about failure by design. No network, a blocked endpoint, a
 * server hiccup -- none of that is something to interrupt somebody
 * with, and all of it is normal for this audience. The next check
 * tries again.
 */
export async function checkAndStage(onState: (state: UpdateState) => void): Promise<void> {
  if (inFlight || staged) return;
  inFlight = true;
  try {
    const update = await check();
    if (!update) return;

    let downloaded = 0;
    let total: number | null = null;
    onState({ status: "downloading", version: update.version, percent: null });

    // Downloaded but not installed. `downloadAndInstall` would apply it
    // immediately, which is exactly what must not happen while a tunnel
    // may be up.
    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        onState({
          status: "downloading",
          version: update.version,
          percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
        });
      }
    });

    staged = update;
    onState({ status: "ready", version: update.version });
  } catch {
    onState({ status: "none" });
  } finally {
    inFlight = false;
  }
}

/** Starts the periodic check. Returns a cancel function. */
export function startUpdateChecks(onState: (state: UpdateState) => void): () => void {
  const first = setTimeout(() => void checkAndStage(onState), FIRST_CHECK_MS);
  const repeat = setInterval(() => void checkAndStage(onState), RECHECK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(repeat);
  };
}

/** Applies a staged update.
 *
 * Only ever called once the tunnel is down -- see the callers in App.
 * `install()` hands off to the NSIS installer in passive mode, which
 * replaces the files.
 *
 * `andRelaunch` is false on the quit path: the customer is closing the
 * app, and reopening it for them is not what they asked for. It is
 * true when they press Restart deliberately.
 */
export async function applyStagedUpdate(andRelaunch: boolean): Promise<void> {
  if (!staged) return;
  const update = staged;
  // Cleared first: if install throws, retrying into a half-applied
  // install is worse than leaving it for the next launch.
  staged = null;
  await update.install();
  if (andRelaunch) await relaunch();
}
