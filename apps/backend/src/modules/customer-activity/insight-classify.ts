/** What kind of thing an app's report was, and what a failure in it was,
 * read from the exact words the apps write.
 *
 * The backend's report shape is fixed (kind, outcome, reason, rungs), so
 * the apps say most of what matters in `reason` and in each rung's
 * `result`. These functions read that text back. The patterns are taken
 * from the client code that writes it -- apps/desktop-windows/src/lib
 * (attempts.ts, connection-config.ts, unanswered-report.ts,
 * auto-reconnect.ts, connection-errors.ts, device-slots.ts, data-check.ts),
 * the Windows service's IKEv2 messages (service/src/engines/ikev2.rs), the
 * mobile app's (apps/mobile/src/screens/Dashboard.tsx, run-diagnostics.ts,
 * the Android IKEv2 engine) and the backend's own error sentences that a
 * sign-in or sign-up report carries -- and anything they do not match is
 * UNKNOWN with its text kept, never a guess. */

/** What a report was. */
export type ReportCategory =
  /** A pass that dialled servers, or a connect that landed. */
  | "connect"
  /** An automatic reconnect: a pass after the tunnel dropped, the episode
   * stopping, or (on phones) the drop itself. */
  | "reconnect"
  /** A background request that could not reach the Neoxify API: a config
   * refresh, the dashboard or server list loading, a server switch, and a
   * probe's follow-up to one of those. Not an attempt to connect. */
  | "api"
  /** A success note, such as a refresh that found changed server
   * parameters. Not an attempt. */
  | "config"
  | "cancelled"
  | "session"
  | "signin"
  | "register"
  /** A run of the fixed-list service check (SERVICE_CHECK). Never a
   * connection attempt and never given a failure code: its results are
   * per target, in `details.services`. */
  | "check"
  | "other";

export interface ReportLike {
  kind: string;
  outcome: string;
  reason: string | null;
  /** Whether the report carried any ladder rungs. */
  hasRungs: boolean;
}

/** `RECONNECT_REASON_PREFIX` in auto-reconnect.ts. */
const RECONNECT = /^auto-reconnect\b/;
/** `asReconnectReport`: one pass of an episode, landed or not. */
const RECONNECT_PASS = /^auto-reconnect attempt \d+ of at most \d+/;
/** `sendFollowUp` in attempts.ts. */
const FOLLOW_UP = /^probe follow-up to the /;
/** `REFILED_HERE_REASON` in control-plane-probe.ts: an unreachable API that
 * was this machine refusing the connect, filed as OTHER. */
const REFILED_HERE = /filed as OTHER, not CONTROL_PLANE_UNREACHABLE/;
/** connection-config.ts: a refresh, on time or late, whose answer moved
 * a server's parameters. Sent as a SUCCESS; it dials nothing. */
const CONFIG_NOTE = /refresh (found|answered after .*? and found) changed server parameters/;
/** The mobile ladder's `reportCancelled`. */
const CANCELLED = /^cancelled by the customer\b/;

export function classifyReport(report: ReportLike): ReportCategory {
  switch (report.kind) {
    case "SESSION":
      return "session";
    case "SIGN_IN":
      return "signin";
    case "REGISTER":
      return "register";
    case "SERVICE_CHECK":
      return "check";
    case "CONNECT":
      break;
    default:
      return "other";
  }
  const reason = report.reason ?? "";
  if (FOLLOW_UP.test(reason)) return "api";
  if (RECONNECT.test(reason)) {
    // A reconnect pass the customer cancelled is still the episode's.
    return "reconnect";
  }
  if (CANCELLED.test(reason)) return "cancelled";
  if (report.outcome === "CONTROL_PLANE_UNREACHABLE") return "api";
  if (report.outcome === "OTHER" && REFILED_HERE.test(reason)) return "api";
  if (report.outcome === "SUCCESS") return CONFIG_NOTE.test(reason) ? "config" : "connect";
  if (report.hasRungs) return "connect";
  // A connect refused before dialling (device-slots.ts `refusalReport`,
  // REJECTED with the server's code) and a ladder that failed on its
  // first rung's engine still were the customer asking for a tunnel.
  if (["NOT_CARRYING_TRAFFIC", "ENGINE_FAILED", "PERMISSION_DENIED", "REJECTED"].includes(report.outcome)) {
    return "connect";
  }
  return "other";
}

/** Whether a report is a real attempt to bring a tunnel up: a connect,
 * or one pass of an automatic reconnect. The reconnect category also
 * holds the episode's stop and a phone's "drop seen", which tried
 * nothing, so those are not counted as attempts. */
export function isConnectAttempt(report: ReportLike, category: ReportCategory = classifyReport(report)): boolean {
  if (category === "connect") return true;
  if (category === "reconnect") return RECONNECT_PASS.test(report.reason ?? "");
  return false;
}

/** A rung the ladder passed over without dialling (`passOverSlow` and
 * `describeSearchEnd` in data-check.ts: "not dialled -- its server was
 * too slow a moment ago"). The phone ladder (mobile Dashboard.tsx) also
 * skips a rung without dialling it: "not available with selected apps"
 * and "not supported on this platform". */
export function rungNotDialled(result: string): boolean {
  return /^(not dialled\b|not available with selected apps\b|not supported on this platform\b)/.test(result);
}

/** A rung that landed. */
export function rungConnected(result: string): boolean {
  return result === "connected" || result.startsWith("connected ");
}

/** A rung that failed: dialled, and neither landed nor the slow fallback
 * the ladder went back to (`describeSearchEnd`). */
export function rungFailed(result: string): boolean {
  return !rungConnected(result) && !rungNotDialled(result) && !/^going back to it\b/.test(result);
}

export type FailureCode =
  | "API_UNREACHABLE"
  | "NOT_CARRYING"
  | "NO_HANDSHAKE_OR_TRAFFIC"
  | "TOO_SLOW"
  | "NO_RESPONSE_UDP_BLOCKED"
  | "DID_NOT_COMPLETE"
  | "SERVER_NOT_REACHED"
  | "NO_NETWORK"
  | "SERVICE_NOT_ANSWERING"
  | "ADAPTER_MISSING"
  | "ENGINE_FAILED"
  | "PERMISSION_DENIED"
  | "OTHER_VPN_ACTIVE"
  | "CANCELLED_BY_CUSTOMER"
  | "SUBSCRIPTION_INACTIVE"
  | "DATA_CAP_REACHED"
  | "DEVICE_LIMIT"
  | "WRONG_PASSWORD"
  | "EMAIL_EXISTS"
  | "BAD_REFERRAL_CODE"
  | "CODE_NOT_ACCEPTED"
  | "SESSION_REFUSED"
  | "CUSTOM_MODE_FAILED"
  | "IKEV2_REFUSED"
  | "TUNNEL_DROPPED"
  | "RECONNECT_GAVE_UP"
  | "APPLE_ACCOUNT_NEEDED"
  | "OPENVPN_DID_NOT_CONNECT"
  | "SERVER_SETTINGS_UNUSABLE"
  | "UNKNOWN";

/** What staff read for each code: what the app reported, never a cause
 * it did not report. */
export const FAILURE_LABELS: Record<FailureCode, string> = {
  API_UNREACHABLE: "The app could not reach the Neoxify API",
  NOT_CARRYING: "Tunnel came up but the app's check got no traffic through it",
  NO_HANDSHAKE_OR_TRAFFIC: "The handshake did not complete or the tunnel carried nothing; the app did not say which",
  TOO_SLOW: "Tunnel carried traffic but the app measured it too slow to keep",
  NO_RESPONSE_UDP_BLOCKED: "IKEv2 on Windows or Linux: no response from the server",
  DID_NOT_COMPLETE: "IKEv2 on Android: the connection did not complete in time",
  SERVER_NOT_REACHED: "The engine reported a timeout, refusal or failed handshake",
  NO_NETWORK: "The app found no network connection to dial over",
  SERVICE_NOT_ANSWERING: "The Windows background service did not answer or was not running",
  ADAPTER_MISSING: "The tunnel's network adapter was missing or could not be created",
  ENGINE_FAILED: "A VPN engine failed to start or is missing from the install",
  PERMISSION_DENIED: "The VPN permission was declined or taken away",
  OTHER_VPN_ACTIVE: "Another VPN held the device",
  CANCELLED_BY_CUSTOMER: "Stopped by the customer",
  SUBSCRIPTION_INACTIVE: "The subscription did not allow a connection",
  DATA_CAP_REACHED: "The plan's data was used up",
  DEVICE_LIMIT: "The plan's device limit refused this device",
  WRONG_PASSWORD: "Wrong email or password",
  EMAIL_EXISTS: "An account with this email already exists",
  BAD_REFERRAL_CODE: "The referral code was not accepted",
  CODE_NOT_ACCEPTED: "A verification, reset or recovery code was not accepted",
  SESSION_REFUSED: "The server refused the session (signed out, revoked or disabled)",
  CUSTOM_MODE_FAILED: "Custom mode (split tunnel) did not start or stopped",
  IKEV2_REFUSED: "IKEv2: the server refused the connection or its credentials",
  TUNNEL_DROPPED: "A phone saw its tunnel drop",
  RECONNECT_GAVE_UP: "An automatic reconnect stopped without a tunnel",
  APPLE_ACCOUNT_NEEDED: "Apple sign-in: the device was not signed in to an Apple Account",
  OPENVPN_DID_NOT_CONNECT: "OpenVPN did not finish connecting or exited",
  SERVER_SETTINGS_UNUSABLE: "IKEv2: the app had no hostname for the server, so it did not dial",
  UNKNOWN: "Not recognised; see the example text",
};

/** First match wins, so the specific sit above the vague -- the same
 * order connection-errors.ts uses where the two overlap. Matched against
 * lowercased text. */
const FAILURE_PATTERNS: [FailureCode, RegExp][] = [
  ["CANCELLED_BY_CUSTOMER", /^cancelled by the customer|the customer pressed (stop reconnecting|something)/],
  [
    "API_UNREACHABLE",
    /could not reach neoxify|config refresh failed|no answer from neoxify|only pages from in front of neoxify|no answer to the session renewal/,
  ],
  ["CUSTOM_MODE_FAILED", /custom mode|split[- ]tunnel|حالت سفارشی/],
  // The phone's Apple sign-in sheet, in the app's language (English and
  // Persian are the two the apps ship). Found unmatched in real reports.
  ["APPLE_ACCOUNT_NEEDED", /sign in to your apple account|وارد حساب اپل/],
  ["NO_RESPONSE_UDP_BLOCKED", /no response from the server|udp is likely blocked/],
  ["DID_NOT_COMPLETE", /the connection did not complete/],
  [
    "IKEV2_REFUSED",
    /the server refused the connection\. check your account|server rejected these credentials|server ended the connection, usually because the credentials|server's certificate was not accepted|internal authentication error/,
  ],
  // The plugin's own check and the phone ladder's sentence: no hostname
  // for an IKEv2 server, so nothing was dialled.
  ["SERVER_SETTINGS_UNUSABLE", /must be a hostname, not an address|has no hostname recorded/],
  ["SERVICE_NOT_ANSWERING", /background service|\bpipe\b|not running/],
  [
    "ADAPTER_MISSING",
    /adapter[^;]*(never appeared|was not found|disappeared|took no address|could not be (read|named|created))|wintun would not create an adapter|wintun adapters[^;]*in use or disabled|failed to open wintun adapter/,
  ],
  // After the adapter line above: an OpenVPN that exited because Wintun
  // would not open is an adapter fault, and its text carries both.
  ["OPENVPN_DID_NOT_CONNECT", /^openvpn (did not finish connecting|exited)/],
  ["OTHER_VPN_ACTIVE", /another vpn|vpn that is none of ours|other vpn|chosen over ours/],
  ["PERMISSION_DENIED", /permission (was )?(declined|denied)|vpn permission|permission is no longer/],
  // "device-limit-reached" is what the ladder writes on a rung the device
  // limit refused; DEVICE_LIMIT / TAKEOVER_LIMIT are the server's codes.
  ["DEVICE_LIMIT", /device[-_ ]limit|takeover_limit|concurrent|too many (active )?connections/],
  ["DATA_CAP_REACHED", /quota|data cap|out of data/],
  // The backend's sign-in sentences, above the vaguer "expired" below.
  ["CODE_NOT_ACCEPTED", /invalid (or expired |email or )?(verification|reset|recovery) (code|link)/],
  ["SESSION_REFUSED", /refresh token|this account is disabled/],
  ["SUBSCRIPTION_INACTIVE", /subscription_inactive|does not allow a connection|suspended|expired|not active|inactive/],
  ["WRONG_PASSWORD", /invalid email or password|password is incorrect/],
  ["EMAIL_EXISTS", /already exists/],
  ["BAD_REFERRAL_CODE", /referral code is not valid|referral programme is not currently running/],
  ["TUNNEL_DROPPED", /drop seen|dropped run summed up/],
  [
    "ENGINE_FAILED",
    /is missing from the install|engine failed to start|could not start|failed to start|tunnel extension (did not start|had not finished starting)|the vpn service did not start|unable to start service intent|backendexception|setting the tunnel's dns failed|^strongswan for built-in/,
  ],
  ["NO_NETWORK", /no network connection with a gateway/],
  ["TOO_SLOW", /too slow/],
  // "up but unreachable", "up but bypassingTunnel", "up but indeterminate"
  // (egress states, Dashboard.tsx) -- a tunnel that came up and proved
  // nothing crossed it.
  ["NOT_CARRYING", /^up but |carried nothing|bypassingtunnel|\bindeterminate\b/],
  ["SERVER_NOT_REACHED", /timed out|timeout|unreachable|refused|no route|network is down|handshake/],
  ["RECONNECT_GAVE_UP", /^auto-reconnect (stopped after|not attempted)/],
];

/** What the app's outcome alone says, where the text says nothing known.
 * NOT_CARRYING_TRAFFIC also covers a handshake that never completed
 * (outcomeFromError in the desktop app's attempts.ts), so on its own it
 * cannot say the tunnel came up. */
const OUTCOME_FALLBACK: Record<string, FailureCode> = {
  CONTROL_PLANE_UNREACHABLE: "API_UNREACHABLE",
  NOT_CARRYING_TRAFFIC: "NO_HANDSHAKE_OR_TRAFFIC",
  ENGINE_FAILED: "ENGINE_FAILED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
};

/** The code for one failure text: a report's reason or a rung's result.
 * `outcome` is the report's, read only when the text matches nothing. */
export function classifyFailure(text: string | null | undefined, outcome?: string): FailureCode {
  const haystack = (text ?? "").toLowerCase();
  if (haystack !== "") {
    // An unreachable API is decided by the outcome where there is one: the
    // reason then carries the trace's words, which can match anything.
    if (outcome === "CONTROL_PLANE_UNREACHABLE") return "API_UNREACHABLE";
    for (const [code, pattern] of FAILURE_PATTERNS) if (pattern.test(haystack)) return code;
  }
  return (outcome && OUTCOME_FALLBACK[outcome]) || "UNKNOWN";
}

/** One report's failure code, or null for a report that did not fail or
 * is not a failure at all (a session, a config note, a probe follow-up).
 * The reason decides; with none, the last failed rung. */
export function reportFailureCode(
  report: ReportLike & { rungResults: string[] },
  category: ReportCategory = classifyReport(report),
): FailureCode | null {
  if (report.outcome === "SUCCESS") return null;
  if (category === "session" || category === "config" || category === "check") return null;
  if (FOLLOW_UP.test(report.reason ?? "")) return null;
  if (category === "cancelled") return "CANCELLED_BY_CUSTOMER";
  // A reconnect pass's reason carries what the pass would have been,
  // after its tag: "...: did not connect (OUTCOME); <reason>".
  const reason = report.reason ?? "";
  const pass = /^auto-reconnect attempt [^:]*: did not connect \(([A-Z_]+)\)(?:; ([\s\S]*))?$/.exec(reason);
  if (pass) {
    const failedRung = [...report.rungResults].reverse().find(rungFailed);
    return classifyFailure(pass[2] ?? failedRung ?? "", pass[1]);
  }
  if (reason !== "") return classifyFailure(reason, report.outcome);
  const failedRung = [...report.rungResults].reverse().find(rungFailed);
  return classifyFailure(failedRung ?? "", report.outcome);
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Runs of hex groups and colons. Only those with "::" or at least three
 * colons are taken as addresses, so a clock time (12:30:45) or a
 * host:port is left alone. */
const IPV6_CANDIDATE = /[0-9a-f]*(?::[0-9a-f]*){2,8}/gi;

/** A text with every IPv4 and IPv6 address replaced by "<address>", for
 * an example shown beside a count. */
export function scrubAddresses(text: string): string {
  return text
    .replace(IPV4, "<address>")
    .replace(IPV6_CANDIDATE, (match) =>
      match.includes("::") || match.split(":").length >= 4 ? "<address>" : match,
    );
}
