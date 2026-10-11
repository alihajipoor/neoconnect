import { invoke } from "@tauri-apps/api/core";
import type { AttemptAddendum } from "./attempts";
import { demoteName } from "./endpoint-demotion";
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
 *     probe: abandoned=connect@1200     (a connect started 1200ms in)
 *
 * One thing the probe can tell that the request cannot is a refusal by
 * this machine (`local`: a permission error on the connect, os error
 * 10013 on Windows -- a firewall here, or one of this app's own filters).
 * The HTTP plugin's error drops the OS error, so such a request is traced
 * `net` like a filtered one. When every attempt failed at once
 * (`failedAtOnce`) and the probe's connect was refused here, the report is
 * filed as OTHER with `REFILED_HERE_REASON` rather than as an unreachable
 * control plane, which the panel reads as the network's doing. What this
 * still misses, and files as unreachable: a failed pre-connect refresh,
 * which is never probed (above); a refusal met while a connect was under
 * way or within `CONNECT_QUIET_MS` of one; a local refusal whose lookup
 * took longer than `AT_ONCE_MS`; and a filter here that blocks the lookup
 * itself, which the probe sees as `dns`. Telling those apart needs the OS
 * error from the plugin, which means forking it. */

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
  // This machine refused the TCP connect before sending anything: a filter
  // on this PC, never the network's doing (`classify_connect_error`).
  "local",
  // The probe itself crashed: a fault here, not a fact about the network.
  "error",
  // The app's requests to the name go through a proxy, so it was not
  // probed: this machine's lookup and handshakes are not the request's
  // (`probe_unless_proxied` in control_plane_probe.rs). Never a block page,
  // whatever the local resolver says.
  "proxy",
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

/** Screen states in which a connect or a disconnect is moving the path
 * the control plane is reached over. A probe begun in one would measure
 * the move. Matched as strings: `appState` is whatever the screen held. */
const PATH_CHANGING: ReadonlySet<string> = new Set(["connecting", "verifying", "disconnecting"]);

/** Whether a screen in `appState` is moving the path: `pathChanging`,
 * for a report made from a screen's state. */
export function pathChangingIn(appState: string | undefined): boolean {
  return appState !== undefined && PATH_CHANGING.has(appState);
}

interface ProbeRun {
  /** The `probe:` section for the report's `apiEndpoint`. */
  section: string;
  /** Whether it is the network's answer, rather than a note that the
   * probe was skipped or abandoned. */
  answered: boolean;
  /** Whether this PC refused every address the probe tried (`local`). */
  allLocal?: boolean;
  /** Whether every attempt of the request failed in transport at once
   * (`failedAtOnce`). */
  atOnce?: boolean;
}

/** How quickly an attempt has to have failed for its failure to be read as
 * a refusal on this machine, once the probe has shown one.
 *
 * A filter here refuses the connect before anything is sent, so the
 * attempt fails in the time a cached lookup and a system call take. Not
 * proof on its own -- a reset from a box near the customer can be nearly
 * as quick, and so is "no route" when the PC is offline -- which is why
 * the probe's `local` is required as well. A local refusal whose lookup
 * was slower than this is missed, and its report stays as it was, with
 * `REFUSED_HERE_REASON` when the probe ran. */
export const AT_ONCE_MS = 50;

/** Whether every attempt in `entries` failed in transport -- `net`, or
 * `local` where the error said so -- within `AT_ONCE_MS` of starting.
 * Nothing answered, nothing timed out, nothing is still running. */
export function failedAtOnce(entries: TraceEntry[]): boolean {
  return (
    entries.length > 0 &&
    entries.every(
      (entry) =>
        (entry.outcome === "net" || entry.outcome === "local") &&
        entry.settledAt !== undefined &&
        entry.settledAt - entry.startedAt < AT_ONCE_MS,
    )
  );
}

/** The reason a report carries when the probe found every address refused
 * by this machine.
 *
 * The HTTP plugin's errors carry no cause -- its message is reqwest's,
 * which leaves out the OS error -- so a request a filter on this PC
 * refused is traced `net`, like a filtered one, and the report is filed as
 * CONTROL_PLANE_UNREACHABLE, which the panel reads as the network's doing.
 * The probe connects by itself and sees WSAEACCES; this puts what it saw
 * where the report's reader looks first. The outcome stays as it is: it is
 * the backend's enum, and a new member of it is a backend change. */
export const REFUSED_HERE_REASON =
  "every address probed was refused by a filter on this PC (os error 10013), not by the network";

/** The reason a report carries when it is filed as OTHER instead of
 * CONTROL_PLANE_UNREACHABLE: every attempt failed at once
 * (`failedAtOnce`), and the probe's connect was refused by this machine.
 *
 * Why OTHER, of the backend's outcomes: REJECTED is "the server answered
 * and said no", and nothing answered; ENGINE_FAILED is the VPN engine; and
 * a new member for a local refusal is a backend and panel change. OTHER is
 * "see the reason on the row", which is what this is. Worded for both
 * apps: the probe's `local` is a permission error on any platform, os
 * error 10013 on Windows. */
export const REFILED_HERE_REASON =
  `refused by this device, not by the network: every attempt failed within ${AT_ONCE_MS}ms and the probe's connect ` +
  "was refused here (permission denied: os error 10013 on Windows); filed as OTHER, not CONTROL_PLANE_UNREACHABLE";

/** Settles the race below when a connect starts. */
const CONNECT_STARTED = Symbol("connect started");

async function runProbe(entries: TraceEntry[], now: number, options: ProbeOptions): Promise<ProbeRun | undefined> {
  try {
    const atOnce = failedAtOnce(entries);
    // Within the interval only a request that failed at once is looked at,
    // and only at its first address: enough to tell a refusal on this
    // machine, which the HTTP plugin's error cannot, from the network's.
    // Where nothing leaves the PC it sends nothing either; otherwise it is
    // one lookup and one handshake. It does not spend the interval, which
    // is for probing every address of a blocked network.
    const quickCheck = lastProbeAt !== null && now - lastProbeAt < PROBE_INTERVAL_MS;
    if (quickCheck && !atOnce) return undefined;
    const failed = probeTargets(entries);
    const targets = quickCheck ? failed.slice(0, 1) : failed;
    if (targets.length === 0) return undefined;
    // Past this point a probe would have run. One that does not is said,
    // and does not count against the interval: nothing was learned. Above
    // all a quick check: a connect may be putting up filters of its own,
    // and a refusal by one of them is not what the request met.
    if (options.pathChanging || (lastConnectAt !== null && now - lastConnectAt < CONNECT_QUIET_MS)) {
      return { section: "probe: skipped=connect", answered: false };
    }
    const previous = lastProbeAt;
    if (!quickCheck) lastProbeAt = now;
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
    const outcomes: string[] = [];
    const parts = targets.map((target, i) => {
      const result = answer[i] as { outcome?: unknown; ms?: unknown } | null;
      const outcome = typeof result?.outcome === "string" && OUTCOMES.has(result.outcome) ? result.outcome : "?";
      const ms = typeof result?.ms === "number" && Number.isFinite(result.ms) ? Math.max(0, Math.round(result.ms)) : 0;
      // Iran's DNS block page for this name: every address under it, on
      // any port, is asked last on this network (endpoint-demotion.ts).
      // A race usually sees that for itself (`resolvesToBlockPage`). This
      // covers what it does not: a lookup slower than the race waits for
      // one, and a name that resolves into the block page and somewhere
      // else as well, which the race leaves alone.
      if (outcome === "blockpage") demoteName(target.host);
      outcomes.push(outcome);
      return `${target.label}=${outcome}@${ms}`;
    });
    return {
      section: `probe: ${parts.join(" ")}`,
      answered: true,
      allLocal: outcomes.every((o) => o === "local"),
      atOnce,
    };
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
  const reasons: string[] = [];
  // Only an answer can have been distorted by a suspension.
  if (run.answered && hidden) reasons.push("app was in the background during the probe");
  // Refused here, by the probe's own connect. The request's failure is
  // read as the same refusal only when it, too, came at once; otherwise
  // the reason says what the probe saw and the outcome stays the network's.
  const refusedHere = run.answered && run.allLocal === true;
  const refile = refusedHere && run.atOnce === true;
  if (refusedHere) reasons.push(refile ? REFILED_HERE_REASON : REFUSED_HERE_REASON);
  return {
    apiEndpoint: run.section,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
    ...(refile ? { outcome: "OTHER" as const } : {}),
  };
}

/** For tests: forget the last probe and connect, as a fresh process would. */
export function resetProbeForTests(): void {
  lastProbeAt = null;
  lastConnectAt = null;
  connectListeners.clear();
}
