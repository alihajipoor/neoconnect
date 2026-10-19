import type { Attempt, ConnectHistory } from "./connect-history";
import { LAMP_FRESH_MS } from "./map-lights";
import type { Protocol, RouteOption } from "./types";

/** What the Activity page may say about "what works on this network".
 *
 * Read from this device's own connect history (connect-history.ts) and
 * nothing else: it never leaves the device, and nothing new is recorded to
 * draw it -- the owner's rule is that a session log stays off (2026-10-19),
 * so this shows only the per-route results the connect ladder already
 * keeps for itself.
 *
 * The same honesty rules as the map's lights (map-lights.ts):
 *  - an attempt is "worked" only when it carried verified traffic; an
 *    engine that came up and proved nothing was recorded as a failure, and
 *    is shown as one;
 *  - only the network the device is on now, and only when that network is
 *    known: the shared "unknown" bucket may describe another network, so
 *    an unknown network shows nothing rather than borrowing it;
 *  - only lately: older than the lights' freshness window (a day), the
 *    evidence describes a network that no longer exists. */

export interface NetworkActivityRow {
  routeId: string;
  protocol: Protocol;
  /** The route as the list has it now, or null for one no longer listed. */
  route: RouteOption | null;
  /** The newest attempt in the window. */
  latest: Attempt;
  /** How many attempts in the window carried traffic, of how many. */
  worked: number;
  tries: number;
}

export function networkActivity(
  history: ConnectHistory,
  network: string | null,
  routes: readonly RouteOption[],
  now: number,
  windowMs: number = LAMP_FRESH_MS,
): NetworkActivityRow[] {
  if (network === null) return [];
  const prefix = `${network}|`;
  const rows: NetworkActivityRow[] = [];
  for (const [key, attempts] of Object.entries(history)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const split = rest.lastIndexOf("|");
    if (split <= 0) continue;
    const routeId = rest.slice(0, split);
    const protocol = rest.slice(split + 1) as Protocol;
    // A future stamp (a clock that moved) counts as now, no newer.
    const recent = attempts.filter((a) => now - Math.min(a.at, now) < windowMs);
    if (recent.length === 0) continue;
    let latest = recent[0];
    for (const attempt of recent) if (attempt.at >= latest.at) latest = attempt;
    rows.push({
      routeId,
      protocol,
      route: routes.find((r) => r.id === routeId && r.protocol === protocol) ?? routes.find((r) => r.id === routeId) ?? null,
      latest,
      worked: recent.filter((a) => a.ok).length,
      tries: recent.length,
    });
  }
  return rows.sort((a, b) => b.latest.at - a.latest.at);
}

/** How many of the routes tried here lately carried traffic on their
 * newest try: the line above the list. */
export function activitySummary(rows: readonly NetworkActivityRow[]): { worked: number; tried: number } {
  return { worked: rows.filter((row) => row.latest.ok).length, tried: rows.length };
}
