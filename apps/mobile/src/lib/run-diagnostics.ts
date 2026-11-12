import { invoke } from "@tauri-apps/api/core";
import { RECONNECT_REASON_PREFIX } from "@shared/lib/auto-reconnect";
import type { PreflightNote } from "./reconnect-steps";

/** What the app tells the backend about a drop, and about a reconnect
 * that would not dial.
 *
 * A crash or a memory kill ends the iPhone's packet tunnel without
 * stopTunnel, so for months the app could say only "the tunnel dropped".
 * The extension now keeps a record of each run (plugins/vpn/xray/
 * diagnostics.go): its stop reason if it had one, a heartbeat every five
 * seconds with the process footprint and its peak, the engine's version,
 * and the Go runtime's fatal output. The plugin hands those files over
 * as text (`vpn_last_run`, iOS only); this file turns them into one line
 * of the `reason` an attempt report already carries -- no backend change,
 * so within its 500 characters.
 *
 * Nothing leaves the phone with an address, a host name, an identifier or
 * a key in it. The fatal output is the only free text, and it is cleaned
 * here as the extension cleans it (`cleanLine` in diagnostics.go), then
 * cut to one line; every other value is a number, or a word from a fixed
 * list, or dropped. */

/** The files, as their text; each null when absent. */
export interface RunFiles {
  lastEnd: string | null;
  run: string | null;
  heartbeat: string | null;
  fatalTail: string | null;
}

/** iOS only. Rejects on Android, whose plugin keeps no such record. */
export const readRunFiles = () => invoke<RunFiles>("vpn_last_run");

/** The most the backend takes in `reason` (ReportAttemptDto). Over it the
 * server answers 400, which the client counts as delivered. */
export const REASON_MAX = 500;

/** NEProviderStopReason, as Apple's headers number it; -1 is the
 * extension's own mark for a start that failed. The same list as
 * `stopReasonName` in diagnostics.go. */
const STOP_REASONS = [
  "none", "userInitiated", "providerFailed", "noNetworkAvailable",
  "unrecoverableNetworkChange", "providerDisabled", "authenticationCanceled",
  "configurationFailed", "idleTimeout", "configurationDisabled",
  "configurationRemoved", "superceded", "userLogout", "userSwitch",
  "connectionFailed", "sleep", "appUpdate", "internalError",
];

export function stopReasonName(reason: number): string {
  if (reason === -1) return "startFailed";
  return Number.isInteger(reason) && reason >= 0 && reason < STOP_REASONS.length ? STOP_REASONS[reason] : "unknown";
}

/** The words a state may be reported as; anything else is "other". */
const STATES = new Set(["invalid", "disconnected", "connecting", "connected", "reasserting", "disconnecting", "unknown"]);
export const stateWord = (state: string | null | undefined): string =>
  state == null ? "unread" : STATES.has(state) ? state : "other";

const ENGINES = new Set(["xray", "wireguard", "none"]);

const reUUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const reEmail = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const reIPv4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
// Two colons or more between hex groups: an IPv6 address (and, as a cost,
// a clock time). A Go frame's "file.go:123" has one.
const reIPv6 = /\[?\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b\]?(?::\d+)?|\[?::(?:[0-9a-f]{1,4}:?){0,7}\]?/gi;
// A path to a source file: only its name is kept. Build paths name the
// machine's user.
const rePath = /(?:[A-Za-z]:)?(?:[/\\][^\s/\\:()]+)+[/\\]([^\s/\\:()]+\.(?:go|s|c|h|m|swift))/g;
const reSecret = /[A-Za-z0-9+/_=-]{20,}/g;
const reHex = /\b0x[0-9a-fA-F]+\b/g;
const reHost = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;
const SOURCE_FILE = /\.(?:go|s|c|h|m|swift)$/i;

/** One line of fatal output with every address, host name, identifier and
 * key-like run taken out, and cut to `max`. A source file's name
 * ("handler.go") is kept: it is public code, and the whole value of the
 * line. */
export function cleanFatalLine(line: string, max = 160): string {
  let out = line.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  out = out.replace(rePath, "$1");
  out = out.replace(reEmail, "<id>");
  out = out.replace(reUUID, "<id>");
  out = out.replace(reIPv4, "<ip>");
  out = out.replace(reIPv6, (s) => (s.split(":").length - 1 < 2 || s.replace(/[:[\] ]/g, "") === "" ? s : "<ip>"));
  out = out.replace(reHex, "0x?");
  out = out.replace(reHost, (s) => (SOURCE_FILE.test(s) ? s : "<host>"));
  out = out.replace(reSecret, "<id>");
  return out.length > max ? out.slice(0, max) : out;
}

/** The line of a fatal output worth sending: its "panic:" or "fatal
 * error:" line, else its last line. Null when there is none. */
export function fatalLine(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const head = lines.find((l) => l.startsWith("panic:") || l.startsWith("fatal error:"));
  return cleanFatalLine(head ?? lines[lines.length - 1]);
}

interface Heartbeat {
  t: number;
  uptimeS: number;
  footprint: number;
  footprintPeak: number;
  available: number;
  engine: string;
  core: string;
  corePatched: boolean;
}

function parse(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function heartbeatOf(value: unknown): Heartbeat | null {
  const h = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!h) return null;
  const t = num(h.t);
  if (t === null) return null;
  return {
    t,
    uptimeS: num(h.uptimeS) ?? -1,
    footprint: num(h.footprint) ?? -1,
    footprintPeak: num(h.footprintPeak) ?? -1,
    available: num(h.available) ?? -1,
    engine: typeof h.engine === "string" && ENGINES.has(h.engine) ? h.engine : "other",
    // A version: digits and dots, a "v" or a suffix at most. Anything else
    // is not sent.
    core: typeof h.core === "string" && /^v?[0-9][0-9A-Za-z.+-]{0,30}$/.test(h.core) ? h.core : "?",
    corePatched: h.corePatched === true,
  };
}

const mib = (bytes: number) => (bytes < 0 ? "?" : `${(bytes / 1048576).toFixed(1)} MiB`);

/** A heartbeat older than this, with no stop recorded, is a run that has
 * ended: a live extension writes one every five seconds. */
const HEARTBEAT_STALE_S = 12;

function memoryAndEngine(h: Heartbeat | null): string {
  if (!h) return "no heartbeat";
  const left = h.available >= 0 ? `, left ${mib(h.available)}` : "";
  return `mem peak ${mib(h.footprintPeak)}, last ${mib(h.footprint)}${left}; engine ${h.engine}, core ${h.core}${h.corePatched ? " patched" : ""}`;
}

/** How the extension's last run ended, as one clause, and the run's key
 * (its start, unix seconds) -- null when there is no record.
 *
 * The latest run's own files are read first: right after a drop that is
 * the run that dropped, which the extension has not yet summed up
 * (tunnel-last-end.json is written at the next start). Without a stop
 * reason, it is said to have ended without one only once its heartbeat
 * has gone quiet; before that the extension may still be running. */
export function describeLastRun(files: RunFiles | null, nowS: number): { key: number | null; text: string } {
  if (!files) return { key: null, text: "run: no record on this platform" };
  const run = parse(files.run);
  const lastEnd = parse(files.lastEnd);
  const startedAt = num(run?.startedAt);
  const lastEndKey = num(lastEnd?.runStartedAt);

  if (startedAt !== null && startedAt !== lastEndKey) {
    const hbRaw = heartbeatOf(parse(files.heartbeat));
    const hb = hbRaw && hbRaw.t >= startedAt ? hbRaw : null;
    const stop = num(run?.stopReason);
    const stoppedAt = num(run?.stoppedAt);
    let how: string;
    if (stop !== null) {
      how = `stopped (${stopReasonName(stop)})${stoppedAt !== null ? `, ${Math.max(0, Math.round(nowS - stoppedAt))} s ago` : ""}`;
    } else if (hb && nowS - hb.t <= HEARTBEAT_STALE_S) {
      how = "no stop reason yet, extension may still be running";
    } else {
      how = `ended without a stop reason${hb ? `, last heartbeat ${Math.max(0, Math.round(nowS - hb.t))} s ago` : ""}`;
    }
    const up = hb ? `, up ${hb.uptimeS} s` : "";
    const fatal = fatalLine(files.fatalTail);
    return {
      key: startedAt,
      text: `run: ${how}${up}; ${memoryAndEngine(hb)}${fatal ? `; fatal: ${fatal}` : ""}`,
    };
  }

  if (lastEnd && lastEndKey !== null) {
    const stop = num(lastEnd.stopReason);
    const how = lastEnd.ended === "stopped" && stop !== null ? `stopped (${stopReasonName(stop)})` : "ended without a stop reason";
    const hb = heartbeatOf(lastEnd.lastHeartbeat);
    const summary = typeof lastEnd.fatalSummary === "string" && lastEnd.fatalSummary !== "" ? cleanFatalLine(lastEnd.fatalSummary) : null;
    const tail = Array.isArray(lastEnd.fatalTail) ? lastEnd.fatalTail.filter((l): l is string => typeof l === "string") : [];
    const fatal = summary ?? (tail.length > 0 ? cleanFatalLine(tail[tail.length - 1]) : null);
    return {
      key: lastEndKey,
      text: `previous run: ${how}${hb ? `, up ${hb.uptimeS} s` : ""}; ${memoryAndEngine(hb)}${fatal ? `; fatal: ${fatal}` : ""}`,
    };
  }
  return { key: null, text: "run: no record" };
}

/** Cut to what the backend takes. The prefix is first, so it survives. */
export const fitReason = (text: string): string => (text.length > REASON_MAX ? text.slice(0, REASON_MAX) : text);

/** The runs already described, so a drop noticed twice (the health poll,
 * then a screen mounting) does not send the same run twice. */
const described = new Set<number>();

/** The `reason` of the report a drop sends: the state the platform last
 * showed, and how the extension's latest run ended. */
export function dropReason(files: RunFiles | null, state: string | null | undefined, nowS: number): string {
  const run = describeLastRun(files, nowS);
  const seen = run.key !== null && described.has(run.key);
  if (run.key !== null) described.add(run.key);
  const text = seen ? "run: already reported" : run.text;
  return fitReason(`${RECONNECT_REASON_PREFIX} drop seen; state ${stateWord(state)}; ${text}`);
}

/** For tests: forget which runs were described. */
export function resetDescribed(): void {
  described.clear();
}

const BRANCH_WORDS: Record<PreflightNote["branch"], string> = {
  otherVpnUp: "a VPN that is none of ours is still up",
  ownStillStopping: "our own tunnel was still not down at the end of the wait",
  unknownStillUp: "a VPN was still up and whose could not be told",
  waitFailed: "the wait for the tunnel to be down could not be made",
  permission: "the VPN permission is no longer this app's",
  chosenElsewhere: "another VPN configuration was chosen over ours",
  accessFailed: "the VPN permission could not be read",
};

/** The `reason` of the report a reconnect's preflight sends when it does
 * not clear an attempt: which check, what it did, and the tunnel state it
 * saw. */
export function preflightReason(note: PreflightNote): string {
  const did = note.outcome === "stop" ? "stopped" : "will retry";
  return fitReason(
    `${RECONNECT_REASON_PREFIX} preflight ${did}: ${BRANCH_WORDS[note.branch]} (${note.branch}); state ${stateWord(note.state)}`,
  );
}
