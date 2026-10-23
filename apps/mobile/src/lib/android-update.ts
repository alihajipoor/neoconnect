import { openUrl } from "@tauri-apps/plugin-opener";
import { publicRequest, type ApiResult } from "@shared/lib/api";
import { socialStartBase } from "@shared/lib/social-auth";

/** Whether a newer Android APK is published -- for the direct-download
 * build only. A Play build is updated by Play and an iPhone by the App
 * Store; neither asks (App.tsx passes the row only to a direct Android
 * build, and the condition is a build-time constant).
 *
 * The backend compares this version with the newest `android-v*` release
 * (updates.controller.ts, `checkAndroid`): 200 with the version and where
 * to download it, 204 when this is the newest, 503 when it could not
 * read the release feed. Android will not let an app replace itself, so
 * the notice offers the download and the system's installer does the
 * rest, with its own confirmation.
 *
 * Asked once per visit to Settings, never on a timer: an update is not
 * worth a request every few minutes on a metered, censored link. */

export type AndroidUpdate =
  | { state: "current" }
  | { state: "available"; version: string; downloadPath: string }
  /** Not answered, or answered with something this does not read: says
   * nothing, rather than "up to date" -- nothing was compared. */
  | { state: "unknown" };

const VERSION = /^\d+\.\d+\.\d+$/;

/** The backend's answer, read strictly: a newer version must be a plain
 * x.y.z and the download a path on the API, or it is not an update. */
export function readAndroidUpdate(result: ApiResult<unknown>): AndroidUpdate {
  if (!result.ok) return { state: "unknown" };
  if (result.data === undefined || result.data === null || result.data === "") return { state: "current" };
  const body = result.data as { version?: unknown; downloadPath?: unknown };
  if (typeof body.version !== "string" || !VERSION.test(body.version)) return { state: "unknown" };
  if (typeof body.downloadPath !== "string" || !body.downloadPath.startsWith("/updates/")) return { state: "unknown" };
  return { state: "available", version: body.version, downloadPath: body.downloadPath };
}

/** The check, for the version this build says it is. The backend takes
 * an architecture in the path and ignores it for Android: the APK is one
 * universal file. */
export async function checkAndroidUpdate(version: string): Promise<AndroidUpdate> {
  if (!VERSION.test(version)) return { state: "unknown" };
  try {
    return readAndroidUpdate(await publicRequest<unknown>(`/updates/android/universal/${version}`));
  } catch {
    return { state: "unknown" };
  }
}

/** Opens the download in the browser, at whichever address of ours is
 * answering -- in Iran often a mirror, not the CDN -- chosen as the social
 * sign-in chooses where the browser goes (`socialStartBase`). The
 * backend redirects to the APK itself. */
export async function openAndroidDownload(downloadPath: string): Promise<void> {
  const base = await socialStartBase();
  await openUrl(`${base.replace(/\/$/, "")}${downloadPath}`);
}
