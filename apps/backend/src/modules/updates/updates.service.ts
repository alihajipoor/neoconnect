import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Desktop releases are tagged separately from the agent's own `v*`
 * tags, so "latest release" on its own is the wrong question -- an
 * agent release would otherwise be offered to the app as an update. */
const TAG_PREFIX = "desktop-v";

const GITHUB_REPO = "alihajipoor/neoconnect";

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
  private cache: { at: number; release: GithubRelease | null } | null = null;

  constructor(private readonly config: ConfigService) {}

  /** The manifest Tauri's updater expects, or null when the caller is
   * already on the newest version. */
  async manifestFor(currentVersion: string): Promise<UpdateManifest | null> {
    const release = await this.latestRelease();
    if (!release) return null;

    const version = release.tag_name.slice(TAG_PREFIX.length);
    if (compareVersions(version, currentVersion) <= 0) return null;

    // Find the payload via its signature rather than by guessing the
    // installer's filename. Tauri's Windows updater artifact has been
    // named several different ways across versions; the one invariant
    // is that the thing to download is whatever the `.sig` sits beside.
    const signatureAsset = release.assets.find((asset) => asset.name.endsWith(".sig"));
    if (!signatureAsset) {
      this.logger.warn(`Release ${release.tag_name} has no .sig asset -- no update offered`);
      return null;
    }
    const payloadName = signatureAsset.name.slice(0, -".sig".length);
    if (!release.assets.some((asset) => asset.name === payloadName)) {
      this.logger.warn(`Release ${release.tag_name} has ${signatureAsset.name} but no ${payloadName}`);
      return null;
    }

    const signature = await fetchText(signatureAsset.browser_download_url);
    if (!signature) return null;

    const base = (this.config.get<string>("publicApiUrl") ?? "").replace(/\/$/, "");

    return {
      version,
      // Release notes are generated from commit messages, which are
      // written for other developers. Better to say nothing than to
      // show a customer a changelog about Prisma migrations.
      notes: release.name && release.name !== release.tag_name ? release.name : "",
      pub_date: release.published_at,
      platforms: {
        "windows-x86_64": {
          signature: signature.trim(),
          // Pointed at us, not at GitHub. This is the indirection that
          // matters: if GitHub becomes unreachable for the customers
          // who most need fixes, the payload host changes here, with
          // no new client release.
          url: `${base}/updates/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(payloadName)}`,
        },
      },
    };
  }

  /** Streams a release asset through this API.
   *
   * Looked up against the real release rather than trusting the path,
   * so this cannot be turned into an open proxy for arbitrary URLs. */
  async assetUrl(tag: string, assetName: string): Promise<string> {
    const release = await this.latestRelease();
    if (!release || release.tag_name !== tag) {
      throw new NotFoundException("Unknown release");
    }
    const asset = release.assets.find((candidate) => candidate.name === assetName);
    if (!asset) {
      throw new NotFoundException("Unknown asset");
    }
    return asset.browser_download_url;
  }

  private async latestRelease(): Promise<GithubRelease | null> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.release;

    let release: GithubRelease | null = null;
    try {
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`,
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "neoxify-api" } },
      );
      if (response.ok) {
        const releases = (await response.json()) as GithubRelease[];
        release =
          releases.find(
            (candidate) =>
              candidate.tag_name.startsWith(TAG_PREFIX) &&
              !candidate.draft &&
              !candidate.prerelease,
          ) ?? null;
      } else {
        this.logger.warn(`GitHub releases request failed: ${response.status}`);
      }
    } catch (err) {
      this.logger.warn(`Could not reach GitHub releases: ${(err as Error).message}`);
    }

    // A failed lookup is cached too, briefly. Otherwise an outage at
    // GitHub turns every client launch into a fresh outbound request.
    this.cache = { at: Date.now(), release };
    return release;
  }
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
