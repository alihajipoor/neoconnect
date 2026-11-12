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

// No lookbehind anywhere here: iOS WebKit before 16.4 throws on it when
// the module loads, and the app supports iOS 15. Where a left boundary is
// needed it is a character that cannot be part of the thing, kept by the
// replacement ("$1"). \b is not used there: it fails next to a letter or
// an underscore, and let "dest_203.0.113.7" through whole.
const reUUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// A URL's user part ("user:pass@"), before the e-mail pattern, which would
// take only what follows its colon.
const reUserinfo = /[^\s/@]*:[^\s/@]*@/g;
const reEmail = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const reIPv4 = /(^|[^\d.])\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g;
// What is left of an IPv6 address whose first group sat against a word
// character, so that the pattern below began after it.
const reIPv6Head = /[0-9a-f]{1,4}<ip>/gi;
// A run of 8 or more hex digits with nothing alphanumeric before it: a
// REALITY short id (up to 16), part of a key or a token.
const reHexRun = /(^|[^0-9A-Za-z])[0-9a-fA-F]{8,}/g;
// Shorter key-like runs: 12 or more of the characters, with both a letter
// and a digit among them. Plain words and plain numbers are kept.
const reMixed = /[A-Za-z0-9+/_=-]{12,}/g;
// Two colons or more between hex groups: an IPv6 address (and, as a cost,
// a clock time). A Go frame's "file.go:123" has one.
const reIPv6 = /\[?\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b\]?(?::\d+)?|\[?::(?:[0-9a-f]{1,4}:?){0,7}\]?/gi;
// A path to a source file: only its name is kept. Build paths name the
// machine's user.
const rePath = /(?:[A-Za-z]:)?(?:[/\\][^\s/\\:()]+)+[/\\]([^\s/\\:()]+\.(?:go|s|c|h|m|swift))/g;
const reSecret = /[A-Za-z0-9+/_=-]{20,}/g;
const reHex = /\b0x[0-9a-fA-F]+\b/g;
const reHost = /(^|[^A-Za-z0-9.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?![A-Za-z0-9-])/gi;
const SOURCE_FILE = /\.(?:go|s|c|h|m|swift)$/i;

/** One line of fatal output with every address, host name, identifier and
 * key-like run taken out, and cut to `max`. A source file's name
 * ("handler.go") is kept: it is public code, and the whole value of the
 * line. */
export function cleanFatalLine(line: string, max = 160): string {
  let out = line.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  out = out.replace(rePath, "$1");
  out = out.replace(reUserinfo, "<id>@");
  out = out.replace(reEmail, "<id>");
  out = out.replace(reUUID, "<id>");
  out = out.replace(reIPv4, "$1<ip>");
  out = out.replace(reIPv6, (s) => (s.split(":").length - 1 < 2 || s.replace(/[:[\] ]/g, "") === "" ? s : "<ip>"));
  out = out.replace(reIPv6Head, "<ip>");
  out = out.replace(reHex, "0x?");
  out = out.replace(reHexRun, "$1<id>");
  out = out.replace(reHost, (s: string, pre: string, host: string) => (SOURCE_FILE.test(host) ? s : `${pre}<host>`));
  out = out.replace(reSecret, "<id>");
  out = out.replace(reMixed, (s) => (/[0-9]/.test(s) && /[A-Za-z]/.test(s) ? "<id>" : s));
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

/** One run described: its key (its start, unix seconds) and the clause.
 * `conclusive` is false only for a run that may still be going, which is
 * not to count as reported. */
export interface RunDescription {
  key: number | null;
  text: string;
  conclusive: boolean;
}

/** States in which the system has the provider down. iOS shows one only
 * after the extension has ended, or after stopTunnel -- whose first act is
 * to record its reason -- so with no reason recorded, the run ended
 * without one, however fresh its last heartbeat. */
const DOWN_STATES = new Set(["disconnected", "invalid"]);

/** How the extension's latest run ended, as one clause. Null when the run
 * files hold none, or only the run tunnel-last-end.json already sums up.
 *
 * Right after a drop the latest run is the one that dropped, which the
 * extension has not yet summed up (tunnel-last-end.json is written at the
 * next start). Without a stop reason it ended without one when the system
 * shows the tunnel down, or once its heartbeat has gone quiet; otherwise
 * the extension may still be running, and that is said, inconclusively. */
function describeLatest(files: RunFiles, state: string | null | undefined, nowS: number): RunDescription | null {
  const run = parse(files.run);
  const startedAt = num(run?.startedAt);
  if (startedAt === null || startedAt === num(parse(files.lastEnd)?.runStartedAt)) return null;
  const hbRaw = heartbeatOf(parse(files.heartbeat));
  const hb = hbRaw && hbRaw.t >= startedAt ? hbRaw : null;
  const stop = num(run?.stopReason);
  const stoppedAt = num(run?.stoppedAt);
  let how: string;
  let conclusive = true;
  if (stop !== null) {
    how = `stopped (${stopReasonName(stop)})${stoppedAt !== null ? `, ${Math.max(0, Math.round(nowS - stoppedAt))} s ago` : ""}`;
  } else if (hb && nowS - hb.t <= HEARTBEAT_STALE_S && !(state != null && DOWN_STATES.has(state))) {
    how = "no stop reason yet, extension may still be running";
    conclusive = false;
  } else {
    how = `ended without a stop reason${hb ? `, last heartbeat ${Math.max(0, Math.round(nowS - hb.t))} s ago` : ""}`;
  }
  const up = hb ? `, up ${hb.uptimeS} s` : "";
  const fatal = fatalLine(files.fatalTail);
  return { key: startedAt, conclusive, text: `run: ${how}${up}; ${memoryAndEngine(hb)}${fatal ? `; fatal: ${fatal}` : ""}` };
}

/** The extension's own summary of the run before the latest one
 * (tunnel-last-end.json), as one clause; null when there is none. */
function describePrevious(files: RunFiles): RunDescription | null {
  const lastEnd = parse(files.lastEnd);
  const key = num(lastEnd?.runStartedAt);
  if (!lastEnd || key === null) return null;
  const stop = num(lastEnd.stopReason);
  const how = lastEnd.ended === "stopped" && stop !== null ? `stopped (${stopReasonName(stop)})` : "ended without a stop reason";
  const hb = heartbeatOf(lastEnd.lastHeartbeat);
  const summary = typeof lastEnd.fatalSummary === "string" && lastEnd.fatalSummary !== "" ? cleanFatalLine(lastEnd.fatalSummary) : null;
  const tail = Array.isArray(lastEnd.fatalTail) ? lastEnd.fatalTail.filter((l): l is string => typeof l === "string") : [];
  const fatal = summary ?? (tail.length > 0 ? cleanFatalLine(tail[tail.length - 1]) : null);
  return {
    key,
    conclusive: true,
    text: `previous run: ${how}${hb ? `, up ${hb.uptimeS} s` : ""}; ${memoryAndEngine(hb)}${fatal ? `; fatal: ${fatal}` : ""}`,
  };
}

/** How the extension's last run ended: the latest run if it is not yet
 * summed up, else the extension's summary of it. `state` is the tunnel
 * state the platform shows now. */
export function describeLastRun(files: RunFiles | null, nowS: number, state?: string | null): RunDescription {
  if (!files) return { key: null, conclusive: true, text: "run: no record on this platform" };
  return describeLatest(files, state, nowS) ?? describePrevious(files) ?? { key: null, conclusive: true, text: "run: no record" };
}

/** Cut to what the backend takes. The prefix is first, so it survives. */
export const fitReason = (text: string): string => (text.length > REASON_MAX ? text.slice(0, REASON_MAX) : text);

/** The runs already described conclusively, so a drop noticed twice (the
 * health poll, then a screen mounting) does not send the same run twice. */
const described = new Set<number>();
/** Runs a drop could only call possibly still running. Their end is sent
 * once the extension has summed them up (`pendingRunReason`). */
const pending = new Set<number>();

/** The run a drop's report describes: the latest run when that is
 * conclusive and not yet sent; else the extension's summary of the run
 * before it, if not yet sent; else the latest run, inconclusive. */
function choose(files: RunFiles | null, state: string | null | undefined, nowS: number): RunDescription | "seen" {
  if (!files) return describeLastRun(null, nowS);
  const latest = describeLatest(files, state, nowS);
  const previous = describePrevious(files);
  const unsent = (d: RunDescription | null) => d !== null && d.key !== null && !described.has(d.key);
  if (latest?.conclusive && unsent(latest)) return latest;
  if (previous && unsent(previous)) return previous;
  if (latest && !latest.conclusive) return latest;
  if (latest || previous) return "seen";
  return { key: null, conclusive: true, text: "run: no record" };
}

function mark(run: RunDescription) {
  if (run.key === null) return;
  if (run.conclusive) {
    described.add(run.key);
    pending.delete(run.key);
  } else {
    pending.add(run.key);
  }
}

/** The `reason` of the report a drop sends: the state the platform last
 * showed, and how the extension's run ended (`choose`). After an IKEv2
 * drop there is no run clause: the system's own client carried it, and the
 * files describe some earlier run of the extension. */
export function dropReason(files: RunFiles | null, state: string | null | undefined, nowS: number, protocol?: string): string {
  if (protocol === "IKEV2") {
    return fitReason(`${RECONNECT_REASON_PREFIX} drop seen; state ${stateWord(state)}; run: IKEv2, the system's own client`);
  }
  const run = choose(files, state, nowS);
  if (run !== "seen") mark(run);
  const text = run === "seen" ? "run: already reported" : run.text;
  return fitReason(`${RECONNECT_REASON_PREFIX} drop seen; state ${stateWord(state)}; ${text}`);
}

/** The `reason` of a follow-up report: the extension's own summary of a run
 * a drop could only call possibly still running, once a later start has
 * written it. Null when nothing is owed. */
export function pendingRunReason(files: RunFiles | null): string | null {
  if (!files || pending.size === 0) return null;
  const previous = describePrevious(files);
  if (!previous || previous.key === null || !pending.has(previous.key)) return null;
  mark(previous);
  return fitReason(`${RECONNECT_REASON_PREFIX} dropped run summed up; ${previous.text}`);
}

/** Whether a follow-up report may be owed (`pendingRunReason`). */
export const runEndOwed = (): boolean => pending.size > 0;

/** For tests: forget which runs were described. */
export function resetDescribed(): void {
  described.clear();
  pending.clear();
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
