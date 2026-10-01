import { Injectable, Logger } from "@nestjs/common";

/** One vantage point's answer about one target. */
export interface ProbeResult {
  /** Vantage id as the provider names it, e.g. "ir3". */
  vantage: string;
  /** Autonomous system the vantage sits in, e.g. "AS213953".
   *
   * The single most useful field here. Iranian operators filter
   * independently of each other, so "blocked" and "blocked on MCI" are
   * different facts and only the ASN tells them apart. */
  asn: string | null;
  city: string | null;
  /** True only when a TCP connection was actually established. */
  ok: boolean;
  latencyMs: number | null;
  /** Provider's own words when it failed. Free-form on purpose: it
   * distinguishes a refused connection from a timeout, and those mean
   * different things about how a node is being blocked. */
  error: string | null;
}

export interface ProbeOutcome {
  results: ProbeResult[];
  /** Vantages asked for, including any that never answered. Without this
   * a cycle where the provider silently dropped half the probes is
   * indistinguishable from one where half the probes genuinely failed. */
  requested: number;
}

/** check-host.net rejects a default user agent outright with 403. */
const USER_AGENT = "neoxify-reachability/1.0";

const BASE = "https://check-host.net";

/** Results are not ready when the check is accepted; the API hands back
 * a request id and fills results in as vantages report. Polling rather
 * than one long sleep so a fast cycle finishes fast. */
const POLL_INTERVAL_MS = 3_000;
const POLL_ATTEMPTS = 8;

/** A single HTTP call's ceiling. The whole cycle is bounded by
 * POLL_INTERVAL_MS * POLL_ATTEMPTS on top of this. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Probes a TCP port from check-host.net's vantage points.
 *
 * TCP rather than ICMP, deliberately. Iranian networks drop and
 * deprioritise ICMP as a matter of course, so a failed ping says almost
 * nothing about whether a customer can reach the node -- it would
 * produce a steady stream of false alarms. Filtering is applied to the
 * IP and port, and increasingly to the TLS handshake itself, so opening
 * a socket to the port the node actually serves on is the measurement
 * that correlates with "the app can connect".
 *
 * Every method fails soft and returns what it has. This is observability
 * infrastructure: it must never throw into the job that runs it, and a
 * probe provider having a bad minute must never read as the fleet being
 * down. That distinction is the caller's to draw, from `requested`
 * versus how many results came back.
 */
@Injectable()
export class CheckHostClient {
  private readonly logger = new Logger(CheckHostClient.name);

  /** Vantage ids available in a country, e.g. ["ir1", ..., "ir8"].
   *
   * Read from the provider rather than hardcoded: the set changes as
   * they add and lose machines, and a hardcoded list silently shrinks
   * the sample until an alert is being decided by two probes. */
  async vantagesIn(country: string): Promise<string[]> {
    const body = await this.getJson<{ nodes?: Record<string, unknown> }>(`${BASE}/nodes/hosts`);
    if (!body) return [];
    const nodes = (body.nodes ?? body) as Record<string, unknown>;
    return Object.keys(nodes)
      .filter((host) => host.startsWith(`${country}`) && /^[a-z]{2}\d+\./.test(host))
      .map((host) => host.split(".")[0])
      .sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
  }

  /**
   * Open a TCP connection to `host:port` from each of `vantages`.
   *
   * Returns only the vantages that answered. A vantage that never
   * reported inside the polling window is absent rather than recorded as
   * a failure, because "did not answer" is a fact about the probe
   * service and recording it as a node failure is exactly the mistake
   * that turns a provider outage into a fleet-wide page.
   */
  async tcpCheck(host: string, port: number, vantages: string[]): Promise<ProbeOutcome> {
    const empty: ProbeOutcome = { results: [], requested: vantages.length };
    if (vantages.length === 0) return empty;

    const query = vantages.map((v) => `node=${encodeURIComponent(`${v}.node.check-host.net`)}`).join("&");
    const submitted = await this.getJson<{
      request_id?: string;
      nodes?: Record<string, string[]>;
    }>(`${BASE}/check-tcp?host=${encodeURIComponent(`${host}:${port}`)}&${query}`);

    if (!submitted?.request_id) {
      this.logger.warn(`check-host did not accept a TCP check for port ${port}`);
      return empty;
    }

    // location metadata arrives with the submission, not with the
    // results, so it is captured here and joined on below.
    const meta = submitted.nodes ?? {};

    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const raw = await this.getJson<Record<string, unknown>>(
        `${BASE}/check-result/${encodeURIComponent(submitted.request_id)}`,
      );
      if (!raw) continue;

      const answered = Object.entries(raw).filter(([, value]) => value !== null);
      const everyoneReported = answered.length >= Object.keys(raw).length && answered.length > 0;

      if (everyoneReported || attempt === POLL_ATTEMPTS) {
        return {
          requested: vantages.length,
          results: answered.map(([host_, value]) => this.toResult(host_, value, meta)),
        };
      }
    }

    return empty;
  }

  /** check-host's per-vantage shape is positional and undocumented:
   * `[{ address, time }]` when the connection succeeded, `[{ error }]`
   * when it did not. Anything else is treated as a failure with no
   * detail rather than trusted. */
  private toResult(host: string, value: unknown, meta: Record<string, string[]>): ProbeResult {
    const vantage = host.split(".")[0];
    const location = meta[host] ?? [];
    const base = {
      vantage,
      // [countryCode, countryName, city, ip, asn]
      city: location[2] ?? null,
      asn: location[4] ?? null,
    };

    const first = Array.isArray(value) ? (value[0] as Record<string, unknown> | undefined) : undefined;

    if (first && typeof first.time === "number") {
      return { ...base, ok: true, latencyMs: Math.round(first.time * 1000), error: null };
    }

    const error =
      first && typeof first.error === "string" ? first.error : "no connection and no reason given";
    return { ...base, ok: false, latencyMs: null, error };
  }

  private async getJson<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        // 429 is the one worth naming: the free tier has limits that are
        // not published, and a cycle that quietly returns nothing looks
        // identical to a fleet-wide outage unless this is in the log.
        this.logger.warn(`check-host ${res.status} for ${url.replace(/\?.*$/, "")}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.warn(`check-host request failed: ${(err as Error).message}`);
      return null;
    }
  }
}
