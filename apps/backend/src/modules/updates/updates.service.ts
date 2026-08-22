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

/** GitHub allows 60 unauthenticated API calls an hour per IP, and 5,000
 * with a token. Every running client asks this endpoint on launch, so
 * without a cache a few dozen customers starting the app in the same
 * hour would exhaust the unauthenticated budget and updates would
 * silently stop being offered. */
const CACHE_MS = 5 * 60_000;

/** How long a *failed* lookup is remembered.
 *
 * Deliberately far shorter than CACHE_MS, and the reason is an outage
 * that really happened: on 2026-08-22 a single 504 from api.github.com
 * was cached as "there is no release" for the full five minutes, and
 * every download link 404'd for that entire window. Caching a failure
 * as long as a success turns a one-second blip at GitHub into a
 * guaranteed multi-minute outage here. Short enough to recover almost
 * immediately, long enough that a sustained GitHub outage still does
 * not mean one outbound request per client launch. */
const FAILURE_CACHE_MS = 30_000;

/** How long a last-known-good answer may still be served after lookups
 * start failing.
 *
 * Serving a slightly stale release beats serving nothing: the customer
 * gets a real installer they can run, and the desktop updater will pull
 * them forward to the newest build on its next successful check. The
 * window is bounded rather than infinite because a stale answer is only
 * harmless while it is nearly current -- a release that gets yanked for
 * being broken must not be served for a week because nobody noticed the
 * feed had been failing since Tuesday. A day covers any plausible
 * GitHub incident and still forces the problem into the open. */
const STALE_MAX_MS = 24 * 60 * 60_000;

/** Without this a hung connection hangs the customer's request with it;
 * `fetch` has no default timeout. */
const FETCH_TIMEOUT_MS = 10_000;

/** Total attempts per lookup, including the first. Three attempts at
 * ~250ms and ~500ms of backoff ride out the transient 5xx that GitHub
 * emits without adding a second to a request that is going to fail
 * anyway. */
const FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 250;

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

/** The three genuinely different answers to "is there an update?".
 *
 * `current` and `unknown` used to be the same value (null), which meant
 * a failed lookup was reported to the customer as "you are up to date"
 * -- a state nothing had verified. Keeping them apart is what lets the
 * controller say "no" and "I could not find out" differently. */
export type UpdateCheck =
  | { status: "update"; manifest: UpdateManifest }
  | { status: "current" }
  | { status: "unknown" };

interface AndroidBuild {
  tag: string;
  asset: string;
  version: string;
}

@Injectable()
export class UpdatesService {
  private readonly logger = new Logger(UpdatesService.name);

  private readonly windowsCache = new ReleaseCache<NewestBuild>("Windows", pickNewestWindowsBuild);
  private readonly androidCache = new ReleaseCache<AndroidBuild>("Android", pickNewestAndroidBuild);

  constructor(private readonly config: ConfigService) {}

  /** What the updater should be told, for a client on `currentVersion`. */
  async checkFor(currentVersion: string): Promise<UpdateCheck> {
    const newest = await this.newestBuild();
    if (!newest) return { status: "unknown" };
    if (compareVersions(newest.version, currentVersion) <= 0) return { status: "current" };

    const signature = await this.fetchSignature(newest.signatureUrl);
    // The release exists and is newer, but its signature could not be
    // read. Tauri refuses an unsigned manifest, so there is nothing to
    // offer -- and saying "up to date" here would be false.
    if (!signature) return { status: "unknown" };

    const base = (this.config.get<string>("publicApiUrl") ?? "").replace(/\/$/, "");

    return {
      status: "update",
      manifest: {
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

  /** Where a release asset really lives.
   *
   * Checked against the release rather than trusted from the path, and
   * rebuilt rather than echoed, so this endpoint cannot be turned into
   * an open redirect to an arbitrary URL. */
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
    return this.windowsCache.resolve(() => this.fetchReleases(), this.logger);
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
  private async newestAndroidBuild(): Promise<AndroidBuild | null> {
    return this.androidCache.resolve(() => this.fetchReleases(), this.logger);
  }

  /** The release feed, or null if it could not be read.
   *
   * Null means "we do not know", never "there are no releases" -- the
   * distinction the caller needs in order to keep serving its last good
   * answer instead of telling customers there is nothing to download.
   */
  private async fetchReleases(): Promise<GithubRelease[] | null> {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;

    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          headers: this.githubHeaders(),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.ok) {
          return (await response.json()) as GithubRelease[];
        }
        if (!isRetryableStatus(response.status) || attempt === FETCH_ATTEMPTS) {
          this.logger.warn(`GitHub releases request failed: ${response.status}`);
          return null;
        }
        this.logger.warn(
          `GitHub releases request failed: ${response.status} (attempt ${attempt}/${FETCH_ATTEMPTS}, retrying)`,
        );
      } catch (err) {
        const message = (err as Error).message;
        if (attempt === FETCH_ATTEMPTS) {
          this.logger.warn(`Could not reach GitHub releases: ${message}`);
          return null;
        }
        this.logger.warn(
          `Could not reach GitHub releases: ${message} (attempt ${attempt}/${FETCH_ATTEMPTS}, retrying)`,
        );
      }

      await delay(RETRY_BACKOFF_MS * attempt);
    }

    return null;
  }

  /** Authenticated when a token is configured, anonymous when not.
   *
   * A token lifts GitHub's limit from 60 requests an hour per IP to
   * 5,000, which takes the rate ceiling off the table as a failure mode
   * entirely. It stays optional on purpose: local dev and CI have no
   * token and must keep working, and 60/hour is ample for one developer.
   */
  private githubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "neoxify-api",
    };
    const token = this.config.get<string>("github.token");
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /** Fetches an update payload's detached signature.
   *
   * Deliberately *not* authenticated: this follows a redirect out to
   * objects.githubusercontent.com, and an Authorization header has no
   * business travelling to an asset host. The repo is public, so none
   * is needed.
   */
  private async fetchSignature(url: string): Promise<string | null> {
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "neoxify-api" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.ok) return await response.text();
        if (!isRetryableStatus(response.status) || attempt === FETCH_ATTEMPTS) {
          this.logger.warn(`Update signature request failed: ${response.status}`);
          return null;
        }
      } catch (err) {
        if (attempt === FETCH_ATTEMPTS) {
          this.logger.warn(`Could not fetch update signature: ${(err as Error).message}`);
          return null;
        }
      }

      await delay(RETRY_BACKOFF_MS * attempt);
    }

    return null;
  }
}

/** A cached release lookup that survives a bad minute at GitHub.
 *
 * Three separate things go wrong when the feed fails, and each needs its
 * own answer:
 *  - a single blip should not become a failed lookup at all, which is
 *    the retry in fetchReleases();
 *  - a failure must not be remembered for as long as a success, or one
 *    bad request owns the endpoint for a full cache period;
 *  - and a failure must not erase an answer we already had, because
 *    "here is last night's installer" is a far better thing to hand a
 *    customer than a 404.
 */
class ReleaseCache<T> {
  private entry: { at: number; ttl: number; value: T | null } | null = null;
  private lastGood: { at: number; value: T } | null = null;

  constructor(
    private readonly label: string,
    private readonly select: (releases: GithubRelease[]) => T | null,
  ) {}

  async resolve(
    fetchReleases: () => Promise<GithubRelease[] | null>,
    logger: Logger,
  ): Promise<T | null> {
    if (this.entry && Date.now() - this.entry.at < this.entry.ttl) {
      return this.entry.value;
    }

    const releases = await fetchReleases();

    if (releases) {
      const value = this.select(releases);
      const at = Date.now();
      this.entry = { at, ttl: CACHE_MS, value };
      // Only a real build is worth remembering. An empty feed is a
      // legitimate "nothing published yet", not something to fall back
      // to later.
      if (value) this.lastGood = { at, value };
      return value;
    }

    const stale =
      this.lastGood && Date.now() - this.lastGood.at < STALE_MAX_MS ? this.lastGood.value : null;

    if (stale) {
      logger.warn(
        `${this.label} release lookup failed; serving the last known good result until GitHub answers again`,
      );
    }

    this.entry = { at: Date.now(), ttl: FAILURE_CACHE_MS, value: stale };
    return stale;
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

function pickNewestWindowsBuild(releases: GithubRelease[]): NewestBuild | null {
  let build: NewestBuild | null = null;
  for (const release of releases) {
    if (!release.tag_name.startsWith(TAG_PREFIX)) continue;
    if (release.draft || release.prerelease) continue;
    const described = describe(release);
    if (!described) continue;
    if (!build || compareVersions(described.version, build.version) > 0) {
      build = described;
    }
  }
  return build;
}

function pickNewestAndroidBuild(releases: GithubRelease[]): AndroidBuild | null {
  let build: AndroidBuild | null = null;
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
  return build;
}

/** Worth trying again, rather than a settled answer.
 *
 * 403 is excluded on purpose even though it is what a rate-limited
 * request returns: the budget does not refill within a retry loop, so
 * retrying a 403 only spends the next request against a limit that is
 * already exhausted.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
