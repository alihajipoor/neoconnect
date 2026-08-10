import type { BotConfig } from "./config.js";

export interface StatusSummary {
  nodes: { total: number; online: number; offline: number; stale: number };
  routes: { total: number; enabled: number };
  regions: { region: string; online: number; total: number }[];
  checkedAt: string;
}

export interface PlatformRelease {
  platform: "windows" | "android";
  /** Null when nothing is released for that platform yet, or the feed failed. */
  version: string | null;
  url: string | null;
  publishedAt: string | null;
}

export interface PublicPlan {
  name: string;
  priceUsd: string;
  durationDays: number;
  dataCapGb: number | null;
  maxDownloadMbps: number | null;
  maxUploadMbps: number | null;
  maxConcurrentConnections: number | null;
}

/** Raised when the panel could not be reached or refused us. Callers turn this
 * into a plain-language reply rather than leaking a stack trace into a public
 * channel. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Thin client over the backend's `/integrations` endpoints.
 *
 * A short timeout on purpose: a Discord interaction must be answered within
 * three seconds before it is deferred, and a bot that hangs waiting on a sick
 * panel is worse than one that says "the panel is not answering".
 */
export class NeoxifyApi {
  constructor(
    private readonly config: BotConfig,
    private readonly timeoutMs = 5000,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.config.apiBaseUrl}${path}`, {
        headers: { "X-Service-Token": this.config.serviceToken },
        signal: controller.signal,
      });

      if (res.status === 401) {
        throw new ApiError("The panel rejected the bot's service token", 401);
      }
      if (!res.ok) {
        throw new ApiError(`The panel returned ${res.status}`, res.status);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ApiError("The panel did not answer in time");
      }
      throw new ApiError(`Could not reach the panel: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  status(): Promise<StatusSummary> {
    return this.get<StatusSummary>("/integrations/status");
  }

  plans(): Promise<PublicPlan[]> {
    return this.get<PublicPlan[]>("/integrations/plans");
  }

  download(): Promise<{ installerUrl: string | null }> {
    return this.get<{ installerUrl: string | null }>("/integrations/download");
  }

  releases(): Promise<PlatformRelease[]> {
    return this.get<PlatformRelease[]>("/integrations/releases");
  }
}
