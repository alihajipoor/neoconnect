import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { checkForNotice, rememberNotice, type LinuxPackageKind, type NoticeAnswer, type SignedPackage } from "./update-notice";
import type { UpdateState } from "./updates";

/** Updates installed from inside the Linux app.
 *
 * Not through Tauri's updater, which would replace files a package manager
 * owns. The API is asked as the notice asks it (lib/update-notice.ts);
 * when its answer carries a signature for this install's package kind, the
 * app downloads that package in the background (`linux_update_download`)
 * and the banner says so, as Windows' does. Restart hands it to the helper
 * (`linux_update_install`), which checks the signature against the key
 * compiled into it and runs the package manager. The package's own scripts
 * restart the helper, so the app then asks how it went
 * (`linux_update_outcome`), tolerating the helper being away while it is
 * replaced, and relaunches once the new version answers.
 *
 * Anything short of that -- no signature, an install the helper cannot
 * update, a download or an install that fails -- falls back to the notice
 * the app showed before this existed, whose button leads to this machine's
 * package. An update is good news that can wait: none of this interrupts
 * anybody, and none of it runs while a tunnel is up (App refuses Restart
 * then, and the helper refuses the install). */

const RECHECK_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 20_000;

/** How often the outcome is asked while the package manager works. */
const OUTCOME_EVERY_MS = 2_000;
/** How long the helper may be silent while it is being replaced: its
 * service is stopped and started again by the package's scripts. */
export const HELPER_AWAY_MS = 120_000;
/** The whole install, at most. A package manager waiting on another one
 * (an unattended upgrade holding the lock) can take minutes; past this the
 * app stops waiting and offers the download instead. */
export const INSTALL_LONGEST_MS = 15 * 60_000;

export type UpdateSupport = { kind: LinuxPackageKind | null; version: string; reason?: string };

export type InstallOutcome =
  | { state: "none" }
  | { state: "running"; version?: string }
  | { state: "installed"; version?: string }
  | { state: "failed"; version?: string; detail?: string };

/** The signed package this install can take from an answer, or null when
 * there is none: no kind (not an install the helper can update), or no
 * signature published for that kind. */
export function signedFor(answer: NoticeAnswer, kind: LinuxPackageKind | null): SignedPackage | null {
  if (answer.state !== "available" || kind === null) return null;
  return answer.signed?.[kind] ?? null;
}

/** What the helper says about this install, or null when it cannot be
 * asked: an older helper, or none running. Either way, the notice. */
export async function updateSupport(): Promise<UpdateSupport | null> {
  try {
    const support = await invoke<UpdateSupport>("linux_update_support");
    const kind = support?.kind === "deb" || support?.kind === "rpm" ? support.kind : null;
    return { kind, version: String(support?.version ?? ""), reason: support?.reason };
  } catch {
    return null;
  }
}

/** The version downloaded and waiting for Restart, held here rather than
 * in React state so it survives navigation between screens. */
let staged: string | null = null;
/** Versions this run tried to install and could not: offered as the
 * notice from then on, never downloaded and tried again on their own. */
const failedVersions = new Set<string>();
let inFlight = false;

export function stagedLinuxUpdate(): string | null {
  return staged;
}

function notice(onState: (state: UpdateState) => void, version: string): void {
  onState(failedVersions.has(version) ? { status: "available", version, installFailed: true } : { status: "available", version });
}

/** One look: the API, then the helper, then the download. */
export async function checkAndStageLinux(onState: (state: UpdateState) => void): Promise<void> {
  if (inFlight || staged) return;
  inFlight = true;
  let available: string | null = null;
  try {
    const answer = await checkForNotice(await getVersion());
    if (answer.state === "current") {
      onState({ status: "none" });
      return;
    }
    // Unknown leaves whatever was said before.
    if (answer.state !== "available") return;
    available = answer.version;

    const support = await updateSupport();
    const kind = support?.kind ?? null;
    rememberNotice(answer, kind);
    // An install that failed before this run, as the helper remembers it,
    // is not tried again on its own either.
    const last = kind ? await installOutcome().catch(() => null) : null;
    if (last?.state === "failed" && last.version === answer.version) failedVersions.add(answer.version);

    const signed = signedFor(answer, kind);
    if (!signed || failedVersions.has(answer.version)) {
      notice(onState, answer.version);
      return;
    }

    const version = answer.version;
    onState({ status: "downloading", version, percent: null });
    const unlisten = await listen<{ downloaded: number; total: number | null }>("linux-update-progress", (event) => {
      const { downloaded, total } = event.payload ?? { downloaded: 0, total: null };
      onState({
        status: "downloading",
        version,
        percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
      });
    }).catch(() => () => undefined);
    try {
      await invoke<void>("linux_update_download", { url: signed.url, signature: signed.signature, version });
    } finally {
      unlisten();
    }
    staged = version;
    onState({ status: "ready", version });
  } catch {
    // A download that did not finish: the notice, so the customer can
    // still get it themselves. Nothing at all when nothing was found.
    if (available) notice(onState, available);
  } finally {
    inFlight = false;
  }
}

/** Starts the periodic check. Returns a cancel function. */
export function startLinuxUpdates(onState: (state: UpdateState) => void): () => void {
  const first = setTimeout(() => void checkAndStageLinux(onState), FIRST_CHECK_MS);
  const repeat = setInterval(() => void checkAndStageLinux(onState), RECHECK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(repeat);
  };
}

export async function installOutcome(): Promise<InstallOutcome> {
  return await invoke<InstallOutcome>("linux_update_outcome");
}

export type WaitDeps = {
  outcome: () => Promise<InstallOutcome>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const REAL_WAIT: WaitDeps = {
  outcome: installOutcome,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** Waits for the install of `version` to finish, and resolves only when
 * the helper says that version is installed. Rejects with the package
 * manager's words when it says the install failed, and when the helper has
 * been silent for longer than a restart takes or the install has run past
 * its longest.
 *
 * "Installed" naming another version is the record of an earlier install,
 * not this one, and is waited past; so is "none", which a helper that has
 * not yet recorded the start can say. */
export async function waitForInstall(version: string, deps: WaitDeps = REAL_WAIT): Promise<void> {
  const start = deps.now();
  let heard = start;
  for (;;) {
    try {
      const outcome = await deps.outcome();
      heard = deps.now();
      if (outcome.state === "installed" && (outcome.version === undefined || outcome.version === version)) return;
      if (outcome.state === "failed" && (outcome.version === undefined || outcome.version === version)) {
        throw new InstallFailed(outcome.detail ?? "the package manager did not install it");
      }
    } catch (err) {
      if (err instanceof InstallFailed) throw err;
      // Away: the helper is being replaced. Kept asking, up to a point.
      if (deps.now() - heard > HELPER_AWAY_MS) throw new Error("the Neoxify service did not come back after the update");
    }
    if (deps.now() - start > INSTALL_LONGEST_MS) throw new Error("the update took too long to install");
    await deps.sleep(OUTCOME_EVERY_MS);
  }
}

class InstallFailed extends Error {}

/** Restart, on Linux: install the staged package, wait for it, relaunch.
 * Only called once the tunnel is down (App). Returns false, with the
 * notice put back, when anything stops it; the app is then still the old
 * version and still usable. */
export async function applyLinuxUpdate(onState: (state: UpdateState) => void, deps: WaitDeps = REAL_WAIT): Promise<boolean> {
  const version = staged;
  if (!version) return false;
  try {
    // Resolves once the helper has started the package manager; rejects
    // with the helper's own sentence when it refuses.
    await invoke<void>("linux_update_install");
    await waitForInstall(version, deps);
  } catch {
    // Cleared, so a later check does not stage the same package again and
    // loop: from now on this version is the notice.
    staged = null;
    failedVersions.add(version);
    notice(onState, version);
    return false;
  }
  staged = null;
  await invoke<void>("linux_relaunch");
  return true;
}

/** For tests: as on a fresh start. */
export function resetLinuxUpdateForTests(): void {
  staged = null;
  failedVersions.clear();
  inFlight = false;
}
