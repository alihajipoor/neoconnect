import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { apiRequest } from "./api";
import { reportAttempt, type AttemptReport } from "./attempts";
import { cleanService, collectDetails, type ReportDetails, type ServiceResult } from "./report-details";

/** The service check: can a short list of well-known services be reached,
 * through the tunnel or directly (docs/client-diagnostics.md, B).
 *
 * THE BOUNDARY. Only the targets the server lists are ever probed or
 * reported, each under the key and host the server gave it; the app holds
 * no list of its own, and nothing the customer visits is ever looked at.
 * The server keeps a result only when its key and host name one of its
 * entries, and this file sends nothing else.
 *
 * Best effort throughout: nothing here delays "Connected", blocks a
 * connect, or shows an error. A run that a disconnect overtakes stops
 * quietly and reports nothing. */

export interface ServiceTarget {
  key: string;
  label: string;
  host: string;
  path: string;
}

export interface TargetList {
  enabled: boolean;
  version: number;
  everyHours: number;
  targets: ServiceTarget[];
}

/** How long the list is kept before it is asked for again. */
export const LIST_TTL_MS = 24 * 3_600_000;
/** Probes at once. */
export const CONCURRENCY = 3;
/** One target's time. */
export const TARGET_MS = 8_000;
/** The whole run's time. */
export const RUN_MS = 25_000;
/** The most targets one run tries: the server's bound on results. */
const MAX_TARGETS = 16;

const STORE_FILE = "service-checks.json";
const LIST_KEY = "targets";
const LAST_RUN_KEY = "lastRunByRoute";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

const HOSTNAME = /^(?=.{1,128}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function cleanTarget(value: unknown): ServiceTarget | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const { key, label, host, path } = raw;
  if (typeof key !== "string" || key.length === 0 || key.length > 32) return null;
  if (typeof host !== "string" || !HOSTNAME.test(host) || /^[\d.]+$/.test(host)) return null;
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 256) return null;
  return { key, host, path, label: typeof label === "string" && label.trim() ? label.trim().slice(0, 64) : key };
}

/** The server's answer, held to what this app will act on. Null for
 * anything that is not a list. */
export function cleanTargetList(value: unknown): TargetList | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled !== "boolean" || !Array.isArray(raw.targets)) return null;
  const version = typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : null;
  if (version === null) return null;
  const everyHours =
    typeof raw.everyHours === "number" && Number.isFinite(raw.everyHours) && raw.everyHours >= 1 ? raw.everyHours : 24;
  const seen = new Set<string>();
  const targets = raw.targets
    .map(cleanTarget)
    .filter((t): t is ServiceTarget => t !== null && !seen.has(t.key) && (seen.add(t.key), true))
    .slice(0, MAX_TARGETS);
  return { enabled: raw.enabled, version, everyHours, targets };
}

/** The list, from the store when it is under a day old, else from the
 * server (and stored). Null when neither has one. Never rejects. */
export async function loadTargets(now: () => number = Date.now): Promise<TargetList | null> {
  let store: Store | null = null;
  try {
    store = await getStore();
    const kept = await store.get<{ list: unknown; at: number }>(LIST_KEY);
    if (kept && typeof kept.at === "number" && now() - kept.at < LIST_TTL_MS && now() >= kept.at) {
      const list = cleanTargetList(kept.list);
      if (list) return list;
    }
  } catch {
    // No store: asked of the server every time, which is once a day anyway.
  }
  try {
    const result = await apiRequest<unknown>("/customer/service-checks/targets");
    if (!result.ok) return null;
    const list = cleanTargetList(result.data);
    if (!list) return null;
    if (store) {
      await store.set(LIST_KEY, { list, at: now() });
      await store.save();
    }
    return list;
  } catch {
    return null;
  }
}

/** One probe: the native `probe_service` (service_probe.rs), held to the
 * report's shape under the target's own key and host. Null when the probe
 * gave no answer -- a command that is missing, refused or never returned:
 * no result is made up for it. */
async function probe(target: ServiceTarget, timeoutMs: number): Promise<ServiceResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      invoke<unknown>("probe_service", { host: target.host, path: target.path, timeoutMs }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs + 1_000);
      }),
    ]);
    if (answer === null || typeof answer !== "object") return null;
    // The key and host are the list's, whatever came back.
    return cleanService({ ...(answer as Record<string, unknown>), key: target.key, host: target.host }) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type RunResult = {
  /** In the list's order; only targets that answered. */
  services: ServiceResult[];
  /** Whether every target of the list answered. */
  complete: boolean;
};

/** Runs `targets`, `CONCURRENCY` at a time, each within `TARGET_MS`, all
 * within `RUN_MS`. A target not begun or not answered by then is left out.
 * Null when `stopped` says so before it ends: nothing is reported then. */
export async function runTargets(
  targets: ServiceTarget[],
  stopped: () => boolean,
  now: () => number = Date.now,
): Promise<RunResult | null> {
  const deadline = now() + RUN_MS;
  const results: (ServiceResult | null)[] = targets.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const left = deadline - now();
      if (stopped() || left < 1_000) return;
      const index = next++;
      results[index] = await probe(targets[index], Math.min(TARGET_MS, left));
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RUN_MS);
    }),
  ]);
  clearTimeout(timer);
  if (stopped()) return null;
  // Copied now: a probe still out past the budget does not count.
  const services = results.filter((r): r is ServiceResult => r !== null);
  return { services, complete: services.length === targets.length };
}

type Via = "tunnel" | "direct";

async function reportRun(
  list: TargetList,
  run: RunResult,
  via: Via | undefined,
  route?: { routeId: string; protocol: string },
): Promise<void> {
  const own: ReportDetails = {
    ...(via ? { via } : {}),
    targetsVersion: list.version,
    services: run.services,
  };
  const report: AttemptReport = {
    kind: "SERVICE_CHECK",
    outcome: run.complete && run.services.every((s) => s.ok) ? "SUCCESS" : "OTHER",
    ...(via === "tunnel" && route ? { routeId: route.routeId, protocol: route.protocol } : {}),
    details: own,
  };
  await reportAttempt(report);
}

/* ------------------------------------------------------------------ *
 * The automatic run, after a connect.
 * ------------------------------------------------------------------ */

export interface LiveRoute {
  routeId: string;
  /** As the CONNECT report names it. */
  protocol: string;
  /** Whether the app's own traffic goes through the tunnel. On Windows and
   * Linux, not in Custom or gaming mode; on a phone, always. */
  fullTunnel: boolean;
}

/** The tunnel the last connect landed on, for the on-demand run. */
let liveRoute: LiveRoute | null = null;
let running = false;

export function foregrounded(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export interface ScheduledRun extends LiveRoute {
  /** Whether that tunnel is still the one up. Asked before starting, and
   * as the run goes: once false, the run stops and says nothing. */
  stillUp: () => boolean;
  /** Whether the app is in front. */
  foreground?: () => boolean;
  now?: () => number;
}

/** After a connect's success report (and its speed sample): the fixed-list
 * test, through the tunnel, at most every `everyHours` per route, when the
 * server has it on, the app is in front, and the app's own traffic goes
 * through the tunnel. Fire and forget; never rejects. Resolves true when a
 * run was reported. */
export async function runScheduledServiceCheck(run: ScheduledRun): Promise<boolean> {
  const { stillUp, foreground = foregrounded, now = Date.now, ...route } = run;
  liveRoute = route;
  if (running) return false;
  running = true;
  try {
    // In Custom mode the app's own traffic bypasses the tunnel: an
    // automatic run would test the bare line under the tunnel's name.
    if (!route.fullTunnel || !stillUp() || !foreground()) return false;
    const list = await loadTargets(now);
    if (!list || !list.enabled || list.targets.length === 0) return false;
    const store = await getStore().catch(() => null);
    const lastRuns = ((await store?.get<Record<string, number>>(LAST_RUN_KEY).catch(() => undefined)) ?? {}) as Record<
      string,
      number
    >;
    const last = lastRuns[route.routeId];
    if (typeof last === "number" && now() - last < list.everyHours * 3_600_000 && now() >= last) return false;
    if (!stillUp() || !foreground()) return false;
    const result = await runTargets(list.targets, () => !stillUp(), now);
    if (result === null || result.services.length === 0) return false;
    if (store) {
      try {
        await store.set(LAST_RUN_KEY, { ...lastRuns, [route.routeId]: now() });
        await store.save();
      } catch {
        // Run again next time: a day's check twice costs nothing.
      }
    }
    await reportRun(list, result, "tunnel", route);
    return true;
  } catch {
    return false;
  } finally {
    running = false;
  }
}

/* ------------------------------------------------------------------ *
 * The run the customer asks for, on the Support screen.
 * ------------------------------------------------------------------ */

export type ServiceCheckAnswer =
  | {
      kind: "done";
      via: Via | undefined;
      version: number;
      results: (ServiceResult & { label: string })[];
      /** Whether every listed target answered. */
      complete: boolean;
      /** How many targets the list had. */
      listed: number;
    }
  /** The server has the check off, or listed nothing. */
  | { kind: "off" }
  /** The list could not be had: not signed in, or no answer. */
  | { kind: "unavailable" };

/** Which way the on-demand run goes: through the tunnel only when the
 * platform says one is up, it is the one the last connect landed on here,
 * and the app's own traffic goes through it. Directly when nothing is up,
 * or the app's own traffic bypasses it. Undefined when a tunnel is up that
 * this run of the app did not bring up -- it cannot say which. */
export async function currentVia(): Promise<{ via: Via | undefined; route?: LiveRoute }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      invoke<unknown>("vpn_status"),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 3_000);
      }),
    ]);
    if (status === null || typeof status !== "object") return { via: undefined };
    const s = status as { connected?: unknown; splitTunnelActive?: unknown };
    if (s.connected !== true) return { via: s.connected === false ? "direct" : undefined };
    if (s.splitTunnelActive === true) return { via: "direct" };
    if (!liveRoute) return { via: undefined };
    return liveRoute.fullTunnel ? { via: "tunnel", route: liveRoute } : { via: "direct" };
  } catch {
    return { via: undefined };
  } finally {
    clearTimeout(timer);
  }
}

/** The check, now, for the customer to see: every listed target, its
 * result under its label. Reported as one SERVICE_CHECK, with the way it
 * went. Never rejects. */
export async function runServiceCheckNow(stopped: () => boolean = () => false): Promise<ServiceCheckAnswer> {
  try {
    const list = await loadTargets();
    if (!list) return { kind: "unavailable" };
    if (!list.enabled || list.targets.length === 0) return { kind: "off" };
    const { via, route } = await currentVia();
    const run = await runTargets(list.targets, stopped);
    // No target answered at all: the probe itself did not run (a build
    // without it), which says nothing about any service.
    if (run === null || run.services.length === 0) return { kind: "unavailable" };
    void reportRun(list, run, via, route);
    const labels = new Map(list.targets.map((t) => [t.key, t.label]));
    return {
      kind: "done",
      via,
      version: list.version,
      complete: run.complete,
      listed: list.targets.length,
      results: run.services.map((s) => ({ ...s, label: labels.get(s.key) ?? s.key })),
    };
  } catch {
    return { kind: "unavailable" };
  }
}

/** The details a diagnostics bundle carries for a run the customer made:
 * the same shape as a SERVICE_CHECK report's. */
export async function bundleDetails(answer: ServiceCheckAnswer | null): Promise<ReportDetails | undefined> {
  const own: ReportDetails | undefined =
    answer?.kind === "done"
      ? {
          ...(answer.via ? { via: answer.via } : {}),
          targetsVersion: answer.version,
          services: answer.results.map(({ label: _label, ...result }) => result),
        }
      : undefined;
  return collectDetails("SERVICE_CHECK", own);
}

export function resetServiceCheckForTests(): void {
  storePromise = null;
  liveRoute = null;
  running = false;
}
