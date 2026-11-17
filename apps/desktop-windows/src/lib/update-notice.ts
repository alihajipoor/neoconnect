import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { publicRequest, type ApiResult } from "./api";
import { getAppLinks } from "./customer";
import { socialStartBase } from "./social-auth";
import type { Language } from "./i18n";
import type { UpdateState } from "./updates";

/** "A new version is available", for a desktop build that does not install
 * this update itself: the macOS shell always, and Linux whenever the
 * signed path (lib/linux-update.ts) does not apply -- no signature for
 * this install's package kind, an install the helper cannot update, or an
 * install that failed.
 *
 * The updater plugin is never called here: on Linux a package manager owns
 * the files, and an app that replaced them itself would fight it. Instead
 * the API is asked the way the Android build asks it
 * (apps/mobile/src/lib/android-update.ts): 204 when this is the newest,
 * 200 with the newer version and where to get it. The notice then opens
 * the package for this machine when its kind is known, or the website's
 * download page, where the customer picks; nothing is downloaded or
 * installed here.
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

export type LinuxPackageKind = "deb" | "rpm";

/** One package's signed download, as the API gives it: an absolute URL
 * through its own download redirect, and the text of the published .sig. */
export type SignedPackage = { url: string; signature: string };

export type NoticeAnswer =
  | { state: "current" }
  | {
      state: "available";
      version: string;
      downloadPath: string;
      /** Each package's own path on the API, when the answer names them. */
      packages?: Partial<Record<LinuxPackageKind, string>>;
      /** Absent for a release published without signatures (0.1.0). */
      signed?: Partial<Record<LinuxPackageKind, SignedPackage>>;
    }
  /** Not answered, or answered with something this does not read: says
   * nothing, rather than "up to date" -- nothing was compared. */
  | { state: "unknown" };

const KINDS: readonly LinuxPackageKind[] = ["deb", "rpm"];

/** The packages' paths, each one taken only if it is a path on the API. */
function readPackages(raw: unknown): Partial<Record<LinuxPackageKind, string>> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Partial<Record<LinuxPackageKind, string>> = {};
  for (const kind of KINDS) {
    const path = (raw as Record<string, unknown>)[kind];
    if (typeof path === "string" && path.startsWith("/updates/")) out[kind] = path;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The signed downloads, each taken whole or not at all: a URL that is not
 * absolute https, or a signature that is not text, is a package this app
 * will not fetch, and the notice is offered for it instead. The helper
 * checks the signature itself before installing anything; this only keeps
 * a malformed answer from starting a download that can only fail. */
function readSigned(raw: unknown): Partial<Record<LinuxPackageKind, SignedPackage>> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Partial<Record<LinuxPackageKind, SignedPackage>> = {};
  for (const kind of KINDS) {
    const entry = (raw as Record<string, unknown>)[kind] as { url?: unknown; signature?: unknown } | undefined;
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.url !== "string" || !/^https:\/\/[^\s]+$/.test(entry.url)) continue;
    if (typeof entry.signature !== "string" || entry.signature.trim() === "") continue;
    out[kind] = { url: entry.url, signature: entry.signature };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The backend's answer, read strictly, as Android's is: a newer version
 * must be a plain x.y.z and the download a path on the API. */
export function readNoticeAnswer(result: ApiResult<unknown>): NoticeAnswer {
  if (!result.ok) return { state: "unknown" };
  if (result.data === undefined || result.data === null || result.data === "") return { state: "current" };
  const body = result.data as { version?: unknown; downloadPath?: unknown; packages?: unknown; signed?: unknown };
  if (typeof body.version !== "string" || !VERSION.test(body.version)) return { state: "unknown" };
  if (typeof body.downloadPath !== "string" || !body.downloadPath.startsWith("/updates/")) return { state: "unknown" };
  const answer: NoticeAnswer = { state: "available", version: body.version, downloadPath: body.downloadPath };
  const packages = readPackages(body.packages);
  if (packages) answer.packages = packages;
  const signed = readSigned(body.signed);
  if (signed) answer.signed = signed;
  return answer;
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
 * is not known, and this machine's own package from it when the helper has
 * said which kind this install is. */
let lastDownloadPath: string | null = null;
let lastPackagePath: string | null = null;
let inFlight = false;

/** Remembers where "Get it" leads for an answer that said a newer version
 * exists: this machine's package when its kind is known and the answer
 * names it, the API's general download otherwise. */
export function rememberNotice(answer: Extract<NoticeAnswer, { state: "available" }>, kind: LinuxPackageKind | null): void {
  lastDownloadPath = answer.downloadPath;
  lastPackagePath = kind ? (answer.packages?.[kind] ?? null) : null;
}

async function checkOnce(onState: (state: UpdateState) => void): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const answer = await checkForNotice(await getVersion());
    if (answer.state === "available") {
      rememberNotice(answer, null);
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

/** Where the notice's button goes. This machine's own package, on
 * whichever of our addresses answers, when the helper said which kind
 * this install is: a .deb offered to a Fedora machine is a download that
 * cannot be opened. Otherwise the website's download page, in the
 * customer's language, from the address the API already serves for the
 * website (the same one Settings' Website link opens), where the customer
 * picks. Without that, the API's own download, as the Android notice
 * does. */
export async function downloadPageUrl(language: Language): Promise<string> {
  if (lastPackagePath) {
    const base = await socialStartBase();
    return `${base.replace(/\/$/, "")}${lastPackagePath}`;
  }
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
  lastPackagePath = null;
  inFlight = false;
}
