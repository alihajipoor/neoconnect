import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Desktop releases are tagged separately from the agent's own `v*`
 * tags, so "latest release" on its own is the wrong question -- an
 * agent release would otherwise be offered to the app as an update. */
const TAG_PREFIX = "desktop-v";

/** Android releases get their own prefix for exactly the same reason,
 * and version independently: the two clients are built from different
 * trees and there is no reason for a Windows fix to bump Android. */
const ANDROID_TAG_PREFIX = "android-v";

const GITHUB_REPO = "alihajipoor/neoconnect";

/** The branded bootstrapper, which is what a person should download.
 * The raw NSIS installer beside it is the updater's payload -- it runs
 * silently and would present no UI to somebody double-clicking it. */
const INSTALLER_ASSET = "Neoxify-Setup.exe";

/** GitHub allows 60 unauthenticated API calls an hour per IP. Every
 * running client asks this endpoint on launch, so without a cache a
 * few dozen customers starting the app in the same hour would exhaust
 * it and updates would silently stop being offered. */
const CACHE_MS = 5 * 60_000;

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: GithubAsset[];
}

export interface UpdateManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

@Injectable()
export class UpdatesService {
  private readonly logger = new Logger(UpdatesService.name);
  private cache: { at: number; build: NewestBuild | null } | null = null;
  private androidCache: {
    at: number;
    build: { tag: string; asset: string; version: string } | null;
  } | null = null;

  constructor(private readonly config: ConfigService) {}

  /** The manifest Tauri's updater expects, or null when the caller is
   * already on the newest version. */
  async manifestFor(currentVersion: string): Promise<UpdateManifest | null> {
    const newest = await this.newestBuild();
    if (!newest) return null;
    if (compareVersions(newest.version, currentVersion) <= 0) return null;

    const signature = await fetchText(newest.signatureUrl);
    if (!signature) return null;

    const base = (this.config.get<string>("publicApiUrl") ?? "").replace(/\/$/, "");

    return {
      version: newest.version,
      // Release notes are generated from commit messages, which are
      // written for other developers. Better to say nothing than to
      // show a customer a changelog about Prisma migrations.
      notes: newest.name && newest.name !== newest.tag ? newest.name : "",
      pub_date: newest.publishedAt,
      platforms: {
        "windows-x86_64": {
          signature: signature.trim(),
          // Pointed at us, not at GitHub. This is the indirection that
          // matters: if GitHub becomes unreachable for the customers
          // who most need fixes, the payload host changes here, with
          // no new client release.
          url: `${base}/updates/download/${encodeURIComponent(newest.tag)}/${encodeURIComponent(newest.payloadName)}`,
        },
      },
    };
  }

  /** The branded installer a human downloads, from the newest release.
   *
   * Exists so the website can link to one URL that never changes.
   * GitHub's own /releases/latest/download cannot be used: "latest"
   * there means the newest release of *any* tag, so an agent release
   * silently hijacks it -- which already broke the node installer once.
   * Pinning a tag by hand is worse again; the site ended up serving
   * 0.8.0 for hours because the pinned tag was a mislabelled release
   * nobody revisited.
   *
   * Resolved through the same newestBuild() the updater uses, so the
   * download and the update path can never disagree about what the
   * current version is. */
  async installerUrl(): Promise<string> {
    const newest = await this.newestBuild();
    if (!newest) {
      throw new NotFoundException("No release is available to download yet");
    }
    return `https://github.com/${GITHUB_REPO}/releases/download/${encodeURIComponent(newest.tag)}/${encodeURIComponent(INSTALLER_ASSET)}`;
  }

  /** The newest Android APK.
   *
   * Same job as installerUrl(), same reasoning, and deliberately the
   * same shape: one URL the website and the tablet can both be pointed
   * at forever, resolved to whatever the newest release actually
   * contains rather than to a tag somebody pinned by hand.
   *
   * There is no updater manifest counterpart, and that is a platform
   * limit rather than an omission: Android will not let an app replace
   * its own APK without the system installer's confirmation, so the
   * honest Android story is "download and tap install", not the silent
   * background replacement the desktop client does.
   */
  async androidApkUrl(): Promise<string> {
    const newest = await this.newestAndroidBuild();
    if (!newest) {
      throw new NotFoundException("No Android release is available to download yet");
    }
    return `https://github.com/${GITHUB_REPO}/releases/download/${encodeURIComponent(newest.tag)}/${encodeURIComponent(newest.asset)}`;
  }

  /** The newest Android release, by the version in the APK's filename.
   *
   * Read from the filename for the reason the desktop path learned the
   * hard way: a tag is written by whoever typed the tag, while the
   * filename is written by the build from the version compiled in. When
   * `desktop-v0.9.0` was pushed against a tree still at 0.8.0 it
   * published a 0.8.0 installer under a 0.9.0 name, and every client
   * that trusted the tag looped on an update it already had.
   */
  private async newestAndroidBuild(): Promise<{ tag: string; asset: string; version: string } | null> {
    if (this.androidCache && Date.now() - this.androidCache.at < CACHE_MS) {
      return this.androidCache.build;
    }

    let build: { tag: string; asset: string; version: string } | null = null;
    try {
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`,
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "neoxify-api" } },
      );
      if (response.ok) {
        const releases = (await response.json()) as GithubRelease[];
        for (const release of releases) {
          if (!release.tag_name.startsWith(ANDROID_TAG_PREFIX)) continue;
          if (release.draft || release.prerelease) continue;
          for (const asset of release.assets) {
            const match = asset.name.match(/^Neoxify-(\d+\.\d+\.\d+)\.apk$/);
            if (!match) continue;
            if (!build || compareVersions(match[1], build.version) > 0) {
              build = { tag: release.tag_name, asset: asset.name, version: match[1] };
            }
          }
        }
      } else {
        this.logger.warn(`GitHub releases request failed: ${response.status}`);
      }
    } catch (err) {
      this.logger.warn(`Could not reach GitHub releases: ${(err as Error).message}`);
    }

    this.androidCache = { at: Date.now(), build };
    return build;
  }

  /** Where a release asset really lives.
   *
   * Checked against the release rather than trusted from the path, and
   * rebuilt rather than echoed, so this endpoint cannot be turned into
   * an open redirect to an arbitrary URL. */
  /** Every platform's newest build in one call, for surfaces that list
   * downloads rather than perform one -- the website and the Discord bot.
   *
   * Each platform is resolved independently and a failure on one is
   * reported as `null` rather than thrown: an Android release that has not
   * happened yet, or a GitHub blip, must not stop the Windows download
   * being shown. The caller decides what to say about a missing entry.
   */
  async releaseSummary(): Promise<PlatformRelease[]> {
    const [windows, android] = await Promise.all([
      this.newestBuild().catch(() => null),
      this.newestAndroidBuild().catch(() => null),
    ]);

    return [
      {
        platform: "windows",
        version: windows?.version ?? null,
        url: windows
          ? `https://github.com/${GITHUB_REPO}/releases/download/${encodeURIComponent(windows.tag)}/${encodeURIComponent(INSTALLER_ASSET)}`
          : null,
        publishedAt: windows?.publishedAt ?? null,
      },
      {
        platform: "android",
        version: android?.version ?? null,
        url: android
          ? `https://github.com/${GITHUB_REPO}/releases/download/${encodeURIComponent(android.tag)}/${encodeURIComponent(android.asset)}`
          : null,
        // The Android path reads its version from the APK filename rather
        // than the release, so there is no publish date to report here.
        publishedAt: null,
      },
    ];
  }

  async downloadUrl(tag: string, assetName: string): Promise<string> {
    const newest = await this.newestBuild();
    if (!newest || newest.tag !== tag || newest.payloadName !== assetName) {
      throw new NotFoundException("Unknown release asset");
    }
    return `https://github.com/${GITHUB_REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  }

  /** The newest *build*, by the version the installer will actually
   * produce -- not by the tag, and not by publication date.
   *
   * Both of those were wrong, and each in a way that shipped. Taking
   * the most recently published release assumes date order and version
   * order agree, which re-tagging after a failed build breaks. Taking
   * the version from the tag assumes whoever tagged it had bumped the
   * app first, which is exactly what went wrong when desktop-v0.9.0 was
   * pushed against a tree still at 0.8.0 and published a 0.8.0
   * installer under a 0.9.0 name.
   *
   * The filename cannot lie in the same way: it is written by the
   * bundler from the version compiled into the app, so it is the
   * version the customer will report after installing. Read it from
   * there and a mislabelled release simply advertises what it really
   * contains, which no client will loop on.
   */
  private async newestBuild(): Promise<NewestBuild | null> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.build;

    let build: NewestBuild | null = null;
    try {
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`,
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "neoxify-api" } },
      );
      if (response.ok) {
        const releases = (await response.json()) as GithubRelease[];
        for (const release of releases) {
          if (!release.tag_name.startsWith(TAG_PREFIX)) continue;
          if (release.draft || release.prerelease) continue;
          const described = describe(release);
          if (!described) continue;
          if (!build || compareVersions(described.version, build.version) > 0) {
            build = described;
          }
        }
      } else {
        this.logger.warn(`GitHub releases request failed: ${response.status}`);
      }
    } catch (err) {
      this.logger.warn(`Could not reach GitHub releases: ${(err as Error).message}`);
    }

    // A failed lookup is cached too, briefly. Otherwise an outage at
    // GitHub turns every client launch into a fresh outbound request.
    this.cache = { at: Date.now(), build };
    return build;
  }
}

export interface PlatformRelease {
  platform: "windows" | "android";
  /** Null when no usable release exists yet, or the feed was unavailable. */
  version: string | null;
  url: string | null;
  publishedAt: string | null;
}

interface NewestBuild {
  tag: string;
  name: string | null;
  version: string;
  payloadName: string;
  signatureUrl: string;
  publishedAt: string;
}

/** Pulls the payload, its signature and its real version out of a
 * release, or nothing if the release is not a usable update.
 *
 * The payload is found via its signature rather than by guessing the
 * installer's filename -- Tauri has named the Windows updater artifact
 * several different ways across versions, and the one invariant is that
 * the file to download is whatever the .sig sits beside. */
function describe(release: GithubRelease): NewestBuild | null {
  const signatureAsset = release.assets.find((asset) => asset.name.endsWith(".sig"));
  if (!signatureAsset) return null;

  const payloadName = signatureAsset.name.slice(0, -".sig".length);
  if (!release.assets.some((asset) => asset.name === payloadName)) return null;

  // Neoxify_0.8.1_x64-setup.exe -- written by the bundler from the
  // version compiled into the binary.
  const match = payloadName.match(/_(\d+\.\d+\.\d+)_/);
  if (!match) return null;

  return {
    tag: release.tag_name,
    name: release.name,
    version: match[1],
    payloadName,
    signatureUrl: signatureAsset.browser_download_url,
    publishedAt: release.published_at,
  };
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "neoxify-api" } });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

/** Positive when `a` is newer. Numeric-part comparison only -- these
 * are our own tags and they are always plain x.y.z. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
