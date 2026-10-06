import { invoke } from "@tauri-apps/api/core";
import { endpointLabel, type TraceEntry } from "./endpoint-trace";

/** After a control-plane request has failed: at which stage did each
 * address fail -- DNS, TCP or TLS?
 *
 * The endpoint trace says which addresses were tried and that each one
 * hung or failed, but the HTTP plugin reports every transport failure in
 * the same words, so it cannot say how. A poisoned name, a blackholed
 * address and an SNI-filtered handshake all read "net" or "timeout" --
 * and they need opposite responses. The Rust side
 * (src-tauri/src/control_plane_probe.rs, compiled into both apps) repeats
 * the failed request's first three steps and stops at the one that
 * fails. Its answer is appended to the report's `apiEndpoint` as
 *
 *     probe: a.example=dns@40 b.example:2053=tls@310
 *
 * Only an outcome class and milliseconds per address come back. No
 * resolved address, no error text.
 *
 * Deliberately not run for a failed *pre-connect* refresh, where it
 * would be most wanted. The connect proceeds the moment the refresh
 * gives up, and a probe still running then is measuring a path that is
 * changing under it -- the old tunnel coming down, the new one coming
 * up, the app's own sockets moving into it. Its answer would describe
 * none of them. A failed sign-in, or a refresh on resume, sets nothing
 * in motion behind it, so what the probe sees is the path the request
 * saw -- through the tunnel, if one was up, which the report's reason
 * says. */

/** The classes the probe can answer with. Anything else is not passed on. */
const OUTCOMES = new Set([
  "ok",
  "dns",
  "dns-timeout",
  "blockpage",
  "tcp",
  "tcp-timeout",
  "tls",
  "tls-timeout",
  "cert",
  // The probe itself crashed: a fault here, not a fact about the network.
  "error",
]);

/** At most one probe per this long, per process.
 *
 * A resume refresh fires on every foreground past the freshness horizon;
 * on a network where the control plane is blocked, every one of them
 * fails. The answer will not have changed in ten minutes, and each probe
 * is a lookup, a TCP handshake and a ClientHello per address. */
const PROBE_INTERVAL_MS = 10 * 60_000;

/** The Rust side gives each stage four seconds; this is the backstop if
 * the command itself never answers. */
const PROBE_DEADLINE_MS = 20_000;

/** Matches the Rust side's ceiling. */
const MAX_TARGETS = 16;

let lastProbeAt: number | null = null;

export interface ProbeTarget {
  host: string;
  port: number;
  label: string;
}

/** The addresses worth probing: each one that failed without an answer,
 * once.
 *
 * Not an address that answered with any HTTP status -- it is reachable.
 * Not one refused by the app's own HTTP permission -- that never left the
 * device, and the probe would only show the network allows what the app
 * does not. Not one stopped because another answered first. */
export function probeTargets(entries: TraceEntry[]): ProbeTarget[] {
  const seen = new Set<string>();
  const targets: ProbeTarget[] = [];
  for (const entry of entries) {
    if (entry.outcome !== "timeout" && entry.outcome !== "net" && entry.outcome !== "pending") continue;
    let url: URL;
    try {
      url = new URL(entry.base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const label = endpointLabel(entry.base);
    if (seen.has(label)) continue;
    seen.add(label);
    targets.push({ host: url.hostname, port: url.port ? Number(url.port) : 443, label });
    if (targets.length === MAX_TARGETS) break;
  }
  return targets;
}

/** Probes the addresses in `entries` that failed, and renders the answer
 * as a `probe:` section -- or undefined if nothing was probed: nothing
 * failed in a way worth probing, a probe ran within the interval, or the
 * shell does not have the command.
 *
 * Never rejects and never takes longer than `PROBE_DEADLINE_MS`. */
export async function probeControlPlane(entries: TraceEntry[], now = Date.now()): Promise<string | undefined> {
  try {
    if (lastProbeAt !== null && now - lastProbeAt < PROBE_INTERVAL_MS) return undefined;
    const targets = probeTargets(entries);
    if (targets.length === 0) return undefined;
    lastProbeAt = now;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PROBE_DEADLINE_MS);
    });
    const answer = await Promise.race([
      invoke<unknown>("probe_control_plane", {
        targets: targets.map(({ host, port }) => ({ host, port })),
      }).catch(() => null),
      deadline,
    ]);
    clearTimeout(timer);

    if (!Array.isArray(answer) || answer.length !== targets.length) return undefined;
    const parts = targets.map((target, i) => {
      const result = answer[i] as { outcome?: unknown; ms?: unknown } | null;
      const outcome = typeof result?.outcome === "string" && OUTCOMES.has(result.outcome) ? result.outcome : "?";
      const ms = typeof result?.ms === "number" && Number.isFinite(result.ms) ? Math.max(0, Math.round(result.ms)) : 0;
      return `${target.label}=${outcome}@${ms}`;
    });
    return `probe: ${parts.join(" ")}`;
  } catch {
    // Decorates a report about a failure; must never become a second one.
    return undefined;
  }
}

/** For tests: forget the last probe, as a fresh process would. */
export function resetProbeForTests(): void {
  lastProbeAt = null;
}
