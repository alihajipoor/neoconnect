import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { publicRequest, type ApiResult } from "./api";
import { getAppLinks } from "./customer";
import { socialStartBase } from "./social-auth";
import type { Language } from "./i18n";
import type { UpdateState } from "./updates";

/** "A new version is available", for a desktop build that cannot install
 * its own updates (Linux, `supportsSelfUpdate`).
 *
 * The updater plugin is never called there: a package manager owns the
 * files, and an app that replaced them itself would fight it. Instead the
 * API is asked the way the Android build asks it
 * (apps/mobile/src/lib/android-update.ts): 204 when this is the newest,
 * 200 with the newer version and where to get it. The notice then opens
 * the website's download page in the browser, where the customer picks
 * the package for their system; nothing is downloaded or installed here.
 *
 * Checked on the same schedule as the Windows updater: once shortly after
 * launch, then every six hours. Silent on failure, for the same reason:
 * a blocked or slow network is normal for this audience and not worth
 * interrupting anybody over. */

const RECHECK_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 20_000;

const VERSION = /^\d+\.\d+\.\d+$/;

/** The only architecture the Linux packages are built for. */
const ARCH = "x86_64";

export type NoticeAnswer =
  | { state: "current" }
  | { state: "available"; version: string; downloadPath: string }
  /** Not answered, or answered with something this does not read: says
   * nothing, rather than "up to date" -- nothing was compared. */
  | { state: "unknown" };

/** The backend's answer, read strictly, as Android's is: a newer version
 * must be a plain x.y.z and the download a path on the API. */
export function readNoticeAnswer(result: ApiResult<unknown>): NoticeAnswer {
  if (!result.ok) return { state: "unknown" };
  if (result.data === undefined || result.data === null || result.data === "") return { state: "current" };
  const body = result.data as { version?: unknown; downloadPath?: unknown };
  if (typeof body.version !== "string" || !VERSION.test(body.version)) return { state: "unknown" };
  if (typeof body.downloadPath !== "string" || !body.downloadPath.startsWith("/updates/")) return { state: "unknown" };
  return { state: "available", version: body.version, downloadPath: body.downloadPath };
}

/** The check, for the version this build says it is. */
export async function checkForNotice(version: string): Promise<NoticeAnswer> {
  if (!VERSION.test(version)) return { state: "unknown" };
  try {
    return readNoticeAnswer(await publicRequest<unknown>(`/updates/linux/${ARCH}/${version}`));
  } catch {
    return { state: "unknown" };
  }
}

/** The download path of the newest answer, for when the website's address
 * is not known. */
let lastDownloadPath: string | null = null;
let inFlight = false;

async function checkOnce(onState: (state: UpdateState) => void): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const answer = await checkForNotice(await getVersion());
    if (answer.state === "available") {
      lastDownloadPath = answer.downloadPath;
      onState({ status: "available", version: answer.version });
    } else if (answer.state === "current") {
      onState({ status: "none" });
    }
    // Unknown leaves whatever was said before: a notice already shown is
    // still true when a later check could not be answered.
  } catch {
    // The version could not be read; nothing to compare.
  } finally {
    inFlight = false;
  }
}

/** Starts the periodic check. Returns a cancel function. */
export function startUpdateNotices(onState: (state: UpdateState) => void): () => void {
  const first = setTimeout(() => void checkOnce(onState), FIRST_CHECK_MS);
  const repeat = setInterval(() => void checkOnce(onState), RECHECK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(repeat);
  };
}

/** Where the notice's button goes: the website's download page, in the
 * customer's language, from the address the API already serves for the
 * website (the same one Settings' Website link opens). Without it, the
 * package itself on whichever of our addresses answers, as the Android
 * notice does. */
export async function downloadPageUrl(language: Language): Promise<string> {
  const links = await getAppLinks().catch(() => null);
  const site = links?.ok ? links.data.websiteUrl?.trim() : null;
  if (site) return `${site.replace(/\/+$/, "")}${language === "fa" ? "/fa" : ""}/download/`;
  const base = await socialStartBase();
  return `${base.replace(/\/$/, "")}${lastDownloadPath ?? `/updates/installer/linux-deb`}`;
}

export async function openDownloadPage(language: Language): Promise<void> {
  await openUrl(await downloadPageUrl(language));
}

/** For tests: as on a fresh start. */
export function resetUpdateNoticeForTests(): void {
  lastDownloadPath = null;
  inFlight = false;
}
