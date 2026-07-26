import type { TranslationKey } from "./i18n";

/** Turning engine failures into something a customer can act on.
 *
 * Connect failures used to surface as `String(err)` -- raw text from the
 * helper service or from wireguard.exe, in a small red line. "The system
 * cannot find the file specified. (os error 2)" tells someone nothing
 * about what to do next, and the cases genuinely differ: a wrong password
 * needs a different response from a blocked port or a second device
 * already using the subscription.
 *
 * The classification is deliberately conservative. Anything not
 * recognised keeps the original text rather than being flattened into a
 * generic "something went wrong" -- an unfamiliar message is at least a
 * clue for support, while a friendly lie is not.
 */
export type ConnectionErrorKind =
  | "serviceUnavailable"
  | "engineMissing"
  | "serverUnreachable"
  | "concurrentLimit"
  | "quotaExhausted"
  | "subscriptionInactive"
  | "unknown";

export interface ClassifiedError {
  kind: ConnectionErrorKind;
  /** Key for the sentence shown to the customer. */
  messageKey: TranslationKey;
  /** The raw text, kept for support rather than display. Never dropped:
   * losing the only record of why something failed is how a report
   * becomes unactionable. */
  detail: string;
}

/** Matched against lowercased text, so patterns stay lowercase. Order
 * matters -- the first match wins, so the specific sit above the vague. */
const PATTERNS: { kind: ConnectionErrorKind; messageKey: TranslationKey; match: RegExp }[] = [
  {
    // The helper service is what actually brings tunnels up; without it
    // nothing else can be diagnosed, so this is checked first.
    kind: "serviceUnavailable",
    messageKey: "err.serviceUnavailable",
    match: /background service|pipe|cannot find the file specified.*pipe|not running/,
  },
  {
    kind: "engineMissing",
    messageKey: "err.engineMissing",
    match: /is missing from the installation|missing from the install/,
  },
  {
    kind: "concurrentLimit",
    messageKey: "err.concurrentLimit",
    match: /concurrent|too many (active )?connections|device limit/,
  },
  {
    kind: "quotaExhausted",
    messageKey: "err.quotaExhausted",
    match: /quota|data cap|out of data/,
  },
  {
    kind: "subscriptionInactive",
    messageKey: "err.subscriptionInactive",
    match: /suspended|expired|not active|inactive/,
  },
  {
    kind: "serverUnreachable",
    messageKey: "err.serverUnreachable",
    match: /timed out|timeout|unreachable|refused|no route|network is down|handshake/,
  },
];

export function classifyConnectionError(raw: unknown): ClassifiedError {
  const detail = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);
  const haystack = detail.toLowerCase();

  for (const { kind, messageKey, match } of PATTERNS) {
    if (match.test(haystack)) return { kind, messageKey, detail };
  }
  return { kind: "unknown", messageKey: "err.unknown", detail };
}
