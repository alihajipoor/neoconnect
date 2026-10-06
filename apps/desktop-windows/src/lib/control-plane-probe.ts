import { invoke } from "@tauri-apps/api/core";
import type { AttemptAddendum } from "./attempts";
import { endpointLabel, type TraceEntry } from "./endpoint-trace";
import { watchBackground } from "./visibility";

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
 * says.
 *
 * That is the app's side. The customer's is another matter: resume is
 * exactly when people press Connect. So a probe is not begun while a
 * connect or disconnect is under way, or within `CONNECT_QUIET_MS` of a
 * connect starting, and one already running when a connect starts is
 * abandoned on the spot (`connectStarting`). Either way the report says
 * so, in place of the stages, rather than leaving a gap that reads like a
 * probe that failed:
 *
 *     probe: skipped=connect
 *     probe: abandoned=connect@1200     (a connect started 1200ms in) */

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

/** No probe begins within this long of a connect starting.
 *
 * A refresh that saw the screen say "connecting" does not ask for a
 * probe at all (`pathChanging`), and that covers most of a connect pass.
 * This covers the seconds before the screen says so: the mobile app sets
 * the state only after its pre-connect refresh, which can take six
 * seconds, and a resume refresh that began inside them would otherwise go
 * on to probe while the connect dials. Generous, because the costs are
 * lopsided: a probe skipped loses one section of one report, while one
 * that ran across a connect reports a path that no longer exists as
 * though it were the network's. */
export const CONNECT_QUIET_MS = 60_000;

let lastConnectAt: number | null = null;
const connectListeners = new Set<() => void>();

/** A connect is starting, and no probe may run across it.
 *
 * Called by `refreshConnectionConfig` for its `connect` trigger, first
 * thing -- the pre-connect refresh is the first step of every connect
 * pass in both apps, from the button and from the failover ladder alike,
 * and it runs whether or not it then asks the server anything. A probe
 * still running is abandoned at once, and the Rust side is told to stop:
 * it begins no new lookup, TCP handshake or ClientHello after that (see
 * `cancel_control_plane_probe` in control_plane_probe.rs). */
export function connectStarting(now = Date.now()): void {
  lastConnectAt = now;
  for (const listener of [...connectListeners]) listener();
}

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

export interface ProbeOptions {
  /** The screen showed a connect or a disconnect under way when the
   * failed request began: the path is moving, so no probe is begun. */
  pathChanging?: boolean;
}

interface ProbeRun {
  /** The `probe:` section for the report's `apiEndpoint`. */
  section: string;
  /** Whether it is the network's answer, rather than a note that the
   * probe was skipped or abandoned. */
  answered: boolean;
}

/** Settles the race below when a connect starts. */
const CONNECT_STARTED = Symbol("connect started");

async function runProbe(entries: TraceEntry[], now: number, options: ProbeOptions): Promise<ProbeRun | undefined> {
  try {
    if (lastProbeAt !== null && now - lastProbeAt < PROBE_INTERVAL_MS) return undefined;
    const targets = probeTargets(entries);
    if (targets.length === 0) return undefined;
    // Past this point a probe would have run. One that does not is said,
    // and does not count against the interval: nothing was learned.
    if (options.pathChanging || (lastConnectAt !== null && now - lastConnectAt < CONNECT_QUIET_MS)) {
      return { section: "probe: skipped=connect", answered: false };
    }
    const previous = lastProbeAt;
    lastProbeAt = now;
    const startedAt = Date.now();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PROBE_DEADLINE_MS);
    });
    let onConnect: (() => void) | undefined;
    const connect = new Promise<typeof CONNECT_STARTED>((resolve) => {
      onConnect = () => resolve(CONNECT_STARTED);
      connectListeners.add(onConnect);
    });
    const answer = await Promise.race([
      invoke<unknown>("probe_control_plane", {
        targets: targets.map(({ host, port }) => ({ host, port })),
      }).catch(() => null),
      deadline,
      connect,
    ]);
    clearTimeout(timer);
    if (onConnect) connectListeners.delete(onConnect);

    if (answer === CONNECT_STARTED) {
      // Whatever it would still say is about a path the connect is
      // replacing. Stopped rather than merely ignored, so it starts no
      // handshakes of its own alongside the connect's.
      void invoke("cancel_control_plane_probe").catch(() => undefined);
      lastProbeAt = previous;
      return { section: `probe: abandoned=connect@${Math.max(0, Date.now() - startedAt)}`, answered: false };
    }

    if (!Array.isArray(answer) || answer.length !== targets.length) return undefined;
    const parts = targets.map((target, i) => {
      const result = answer[i] as { outcome?: unknown; ms?: unknown } | null;
      const outcome = typeof result?.outcome === "string" && OUTCOMES.has(result.outcome) ? result.outcome : "?";
      const ms = typeof result?.ms === "number" && Number.isFinite(result.ms) ? Math.max(0, Math.round(result.ms)) : 0;
      return `${target.label}=${outcome}@${ms}`;
    });
    return { section: `probe: ${parts.join(" ")}`, answered: true };
  } catch {
    // Decorates a report about a failure; must never become a second one.
    return undefined;
  }
}

/** Probes the addresses in `entries` that failed, and renders the answer
 * as a `probe:` section -- or undefined if nothing was probed: nothing
 * failed in a way worth probing, a probe ran within the interval, or the
 * shell does not have the command. A probe kept from running, or cut
 * short, by a connect is a section saying so (see the header).
 *
 * Never rejects and never takes longer than `PROBE_DEADLINE_MS`. */
export async function probeControlPlane(
  entries: TraceEntry[],
  now = Date.now(),
  options: ProbeOptions = {},
): Promise<string | undefined> {
  return (await runProbe(entries, now, options))?.section;
}

/** The probe as an addendum to a report that has already been made (see
 * `reportAttempt`): the report goes the moment the request has failed,
 * and this follows it when the probe answers -- up to twenty seconds
 * later, which on iOS is long enough for a backgrounded app to be
 * suspended and killed with a report it was still holding.
 *
 * Says so if the app went to the background while the probe ran: on iOS
 * that suspends the probe's threads, and its timeouts then describe the
 * suspension rather than the network. */
export async function probeAddendum(
  entries: TraceEntry[],
  options: ProbeOptions = {},
): Promise<AttemptAddendum | undefined> {
  const backgrounded = watchBackground();
  const run = await runProbe(entries, Date.now(), options);
  const hidden = backgrounded();
  if (run === undefined) return undefined;
  // Only an answer can have been distorted by a suspension.
  return run.answered && hidden
    ? { apiEndpoint: run.section, reason: "app was in the background during the probe" }
    : { apiEndpoint: run.section };
}

/** For tests: forget the last probe and connect, as a fresh process would. */
export function resetProbeForTests(): void {
  lastProbeAt = null;
  lastConnectAt = null;
  connectListeners.clear();
}
