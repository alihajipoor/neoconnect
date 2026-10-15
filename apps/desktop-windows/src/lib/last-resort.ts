import { invoke } from "@tauri-apps/api/core";
import type { LastResortEntry } from "./endpoint-bundle";
import { lastResortEntries } from "./endpoint-bundle-store";
import { ladderPass } from "./ladder-pass";
import { networkKeyFromAsn, stampedCountry } from "./network-identity";
import { relayAllows } from "./relay-calls";

/** The relay of last resort: when every ordinary route to the API has
 * failed, a few of the app's own calls sent to a box inside Iran
 * (docs/relay-last-resort.md, section 1).
 *
 * This file decides *whether* a call goes to the relay, and keeps the
 * state that decision needs. How it is sent -- by address, with no SNI,
 * accepted by SPKI pin, from a fixed list of calls -- is the Rust
 * command's (src-tauri/src/relay_http.rs). Which requests ask is api.ts's
 * and auth.ts's: a request opts in, and only after every ordinary
 * attempt has failed in a way only blocking explains
 * (`everyRouteFailed` in api.ts), or while relay mode says the ordinary
 * routes were found blocked minutes ago.
 *
 * The order of checks below is the spec's, and the reason for each:
 *
 *  1. The call is one the relay carries (relay-calls.ts). Nothing else is
 *     ever routed this way, so nothing else prompts or spends budget.
 *  2. The signed bundle names a relay. Only a `lastResort` entry does;
 *     it never reaches `apiEndpoints()`, the HTTP scope, the remembered
 *     address, the updater or the probes (endpoint-bundle.ts).
 *  3. The relay is not switched off for this network after the backend
 *     said the caller is not in Iran (R1.7: 24 hours).
 *  4. Evidence the device is in Iran (R1.3): the server's own country
 *     stamp for this network, or on a network never stamped, the time
 *     zone or the region. A cost and honesty gate, not security -- the
 *     backend checks the region itself.
 *  5. Consent, once per install, before any byte is sent (R1.4). A
 *     decline is remembered. Only a foreground request -- one the
 *     customer just asked for -- may ask; a background one never does.
 *  6. At send time, one call at a time: the tunnel is down and no connect
 *     is under way (R1.5), and the device budget has room (R1.6).
 *
 * Nothing is raced. Two boxes at most per call, twelve seconds in all,
 * each given what is left of that (the command's own connect timeout is
 * four seconds).
 */

export type RelayUse = "foreground" | "background";

export interface RelayCall {
  method: "GET" | "POST";
  /** Relative to `/api`. */
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

/** What the command resolves with: the HTTP answer, whatever its status. */
export interface RelayAnswer {
  status: number;
  contentType: string;
  etag?: string;
  body: string;
}

export type RelaySkip =
  /** Not a call the relay carries. */
  | "path"
  /** The bundle names no relay. */
  | "none"
  /** No evidence this device is in Iran. */
  | "not-iran"
  /** The customer said no, now or before. */
  | "declined"
  /** Nobody was asked: a background request, or no screen to ask on. */
  | "unasked"
  /** Switched off on this network after the backend said it is not Iran. */
  | "off"
  /** The device's hourly or daily allowance is spent. */
  | "budget";

export type RelayOutcome =
  /** The relay delivered an answer: the backend's JSON, or a page from the
   * box or the origin in front of it. */
  | { kind: "answered"; answer: RelayAnswer }
  /** The relay was dialled and nothing answered. */
  | { kind: "unanswered" }
  /** A tunnel is up or being brought up: the relay was not dialled. */
  | { kind: "gated" }
  /** Not sent, for the reason given. */
  | { kind: "skipped"; reason: RelaySkip };

/** R1.6. Counted per device, over every network, and only for attempts
 * that got past the TCP handshake -- a box that never answered a SYN has
 * cost the backend nothing. */
export const RELAY_HOURLY_LIMIT = 40;
export const RELAY_DAILY_LIMIT = 200;
/** At most this many boxes for one call (R1.6). */
export const RELAY_MAX_BOXES = 2;
/** All the time one call may take across its boxes (R1.6). The sign-in
 * deadline grows by this, since the relay leg runs on its own clock. */
export const RELAY_CALL_MS = 12_000;
/** Relay mode lasts this long after the last answer from the backend
 * through the relay, per network (R1.7). */
export const RELAY_MODE_MS = 15 * 60_000;
/** In relay mode the ordinary routes are asked again at most this often;
 * an answer there ends relay mode (R1.7). */
export const NORMAL_PROBE_MS = 3 * 60_000;
/** How long the relay stays off on a network the backend said is not in
 * Iran (R1.7). */
export const RELAY_REGION_OFF_MS = 24 * 3_600_000;
/** Relay mode ends after this many relay calls in a row got no answer. */
const FAILURES_TO_END = 2;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** How long the tunnel's state may take to read before it counts as not
 * known -- which closes the gate. */
const TUNNEL_READ_MS = 3_000;

const CONSENT_KEY = "neoxify.relay.consent";
const STATE_KEY = "neoxify.relay";
const INSTALL_KEY = "neoxify.relay.install";

/** Errors from the command (`RelayError` in relay_http.rs) that leave the
 * request undelivered: nothing reached the backend, so a second box may
 * be asked whatever the method. */
const UNDELIVERED = new Set(["relay: connect-timeout", "relay: pin-mismatch", "relay: tls"]);

/** Errors the command reports only after a TCP connection was made, and
 * so the ones counted against the budget besides an answer. A connect
 * timeout or a refused connection is not: that box cost nobody anything. */
const CONNECTED = new Set([
  "relay: pin-mismatch",
  "relay: tls",
  "relay: timeout",
  "relay: too-large",
  "relay: bad-response",
  "relay: not-utf8",
]);

/** Errors in the call itself, which no other box would answer differently. */
const REFUSED_LOCALLY = new Set(["relay: bad-base", "relay: bad-pins", "relay: refused-path", "relay: bad-request"]);

// ---------------------------------------------------------------------------
// Storage. Per device and best-effort, as endpoint-demotion.ts keeps its
// own: a private window or cleared storage forgets the consent (it is
// asked again) and the budget (which the backend's caps back up).

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

interface Persisted {
  /** Network key -> when relay mode ends there. */
  mode: Record<string, number>;
  /** Network key -> until when the relay is off there. */
  off: Record<string, number>;
  /** When each counted attempt was made, the last day's. */
  sent: number[];
}

let state: Persisted | null = null;

function load(): Persisted {
  if (state) return state;
  let parsed: Partial<Persisted> = {};
  try {
    const raw = storage()?.getItem(STATE_KEY);
    if (raw) parsed = JSON.parse(raw) as Partial<Persisted>;
  } catch {
    parsed = {};
  }
  state = {
    mode: parsed.mode && typeof parsed.mode === "object" ? parsed.mode : {},
    off: parsed.off && typeof parsed.off === "object" ? parsed.off : {},
    sent: Array.isArray(parsed.sent) ? parsed.sent.filter((t) => typeof t === "number") : [],
  };
  return state;
}

function save(): void {
  try {
    storage()?.setItem(STATE_KEY, JSON.stringify(load()));
  } catch {
    // Held in memory for this run.
  }
}

// ---------------------------------------------------------------------------
// Seams: the clock, the transport, the environment and the tunnel's state
// are set by the app (App.tsx in each client) and by tests.

let clock: () => number = () => Date.now();

type Transport = (args: {
  base: string;
  pins: string[];
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}) => Promise<RelayAnswer>;

let transport: Transport = (args) => invoke<RelayAnswer>("relay_request", args);

interface Environment {
  timeZone: string | undefined;
  languages: readonly string[];
}

function defaultEnvironment(): Environment {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  const languages =
    typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
  return { timeZone, languages };
}

let environment: () => Environment = defaultEnvironment;

/** Whether a tunnel is up: true, false, or null when it cannot be told. */
type TunnelReader = () => Promise<boolean | null>;
let tunnelReader: TunnelReader | null = null;

/** Tells this file how to ask whether a tunnel is up. Set once by each
 * app at start (App.tsx). A build that never sets it -- the web portal,
 * which shares these screens and has no tunnel and no relay command --
 * has no relay at all (`relaySupported`). */
export function setRelayTunnelReader(reader: TunnelReader | null): void {
  tunnelReader = reader;
}

/** Whether this build can use the relay of last resort at all: a Tauri
 * app that has said how to read its tunnel. The screens hide the relay's
 * switch where it cannot. */
export function relaySupported(): boolean {
  return tunnelReader !== null;
}

// ---------------------------------------------------------------------------
// Consent (R1.4).

export type RelayConsent = "granted" | "declined" | null;

/** What the customer said about the backup route on this install, or null
 * if they were never asked. */
export function relayConsent(): RelayConsent {
  try {
    const value = storage()?.getItem(CONSENT_KEY);
    return value === "granted" || value === "declined" ? value : null;
  } catch {
    return null;
  }
}

/** Records the customer's answer -- from the prompt, or from the switch in
 * Settings. Turning it off ends relay mode at once. */
export function setRelayConsent(granted: boolean): void {
  try {
    storage()?.setItem(CONSENT_KEY, granted ? "granted" : "declined");
  } catch {
    // Asked again next time; nothing was sent meanwhile.
  }
  if (!granted) endRelayMode();
  notify();
}

type ConsentAsker = () => Promise<boolean>;
let asker: ConsentAsker | null = null;
let asking: Promise<boolean | null> | null = null;

/** Registers the screen that asks for consent (BackupRouteConsent). One at
 * a time; returns the unregister. Without one, nothing is asked and a
 * foreground request goes without the relay. */
export function onRelayConsentAsked(ask: ConsentAsker): () => void {
  asker = ask;
  return () => {
    if (asker === ask) asker = null;
  };
}

async function consentFor(use: RelayUse): Promise<"granted" | "declined" | "unasked"> {
  const held = relayConsent();
  if (held !== null) return held;
  if (use === "background" || asker === null) return "unasked";
  // Requests that find the question already on screen wait for its
  // answer: one prompt, however many requests needed the relay.
  asking ??= asker()
    .then((granted) => {
      setRelayConsent(granted);
      return granted;
    })
    .catch(() => null)
    .finally(() => {
      asking = null;
    });
  const answer = await asking;
  if (answer === null) return "unasked";
  return answer ? "granted" : "declined";
}

// ---------------------------------------------------------------------------
// Where the device is (R1.3), and which network it is on.

/** The key the relay's per-network memories use. The carrier, as the
 * endpoint demotions key it, or one shared bucket when unknown. */
function networkKey(): string {
  try {
    return networkKeyFromAsn(clock()) ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Whether there is evidence this device is in Iran: the server's last
 * country stamp for this network (network-identity.ts) when there is
 * one -- which overrules the device's own settings either way -- and on a
 * network never stamped, the time zone or the region the device is set
 * to. */
export function iranEvidence(): boolean {
  let stamped: string | null = null;
  try {
    stamped = stampedCountry(networkKeyFromAsn(clock()));
  } catch {
    stamped = null;
  }
  if (stamped !== null) return stamped === "IR";
  const env = environment();
  if (env.timeZone === "Asia/Tehran") return true;
  return env.languages.some((tag) => /^[a-z]{2,3}(-[A-Za-z]{4})?-IR\b/i.test(tag));
}

// ---------------------------------------------------------------------------
// Relay mode (R1.7), and what the screens show while it lasts.

let failures = 0;
let lastNormalProbe = 0;
let lastGoodBox: string | null = null;

export interface RelayStatus {
  /** Whether sign-up through the relay is open. */
  signup: boolean;
  /** Whether the owner has declared a national intranet. The only source
   * of that word anywhere in the app (I4). */
  intranet: boolean;
}

let status: RelayStatus | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One screen's failure is not another's.
    }
  }
}

/** Calls `listener` whenever relay mode, the consent or the relay's status
 * changes. Returns the unsubscribe. */
export function onRelayChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether relay mode holds on this network now: the backend answered
 * through the relay in the last fifteen minutes, and nothing since has
 * ended it. */
export function relayModeActive(): boolean {
  // A connect under way is a tunnel connect, which ends relay mode; it is
  // ended for good when the relay is next asked (`send`).
  if (ladderPass.inFlight()) return false;
  const until = load().mode[networkKey()];
  return typeof until === "number" && until > clock();
}

/** Ends relay mode on every network: a tunnel connect, an answer on an
 * ordinary route, the customer switching the relay off. */
export function endRelayMode(): void {
  const held = load();
  const had = Object.keys(held.mode).length > 0;
  held.mode = {};
  failures = 0;
  status = null;
  if (had) {
    save();
    notify();
  }
}

/** Called by api.ts whenever the backend answers on an ordinary route:
 * whatever relay mode held, the usual way works again. */
export function noteNormalRouteAnswered(): void {
  if (Object.keys(load().mode).length > 0) endRelayMode();
}

/** Whether a request opted into the relay should skip the ordinary routes
 * and go straight to it: relay mode holds, and the ordinary routes were
 * asked less than `NORMAL_PROBE_MS` ago. When they are due, this answers
 * false once and counts that request as the probe. */
export function skipNormalRoutes(): boolean {
  if (!relayModeActive()) return false;
  const now = clock();
  if (now - lastNormalProbe >= NORMAL_PROBE_MS) {
    lastNormalProbe = now;
    return false;
  }
  return true;
}

/** The relay's own word on sign-up and the intranet, when it has been
 * asked during this relay mode (`refreshRelayStatus`). */
export function relayStatus(): RelayStatus | null {
  return status;
}

/** Asks the backend, through the relay, whether relay sign-up is open and
 * whether an intranet has been declared. Background: never prompts. */
export async function refreshRelayStatus(): Promise<RelayStatus | null> {
  const outcome = await relayRequest({ method: "GET", path: "/relay/status" }, "background");
  if (outcome.kind !== "answered" || outcome.answer.status !== 200) return status;
  try {
    const body = JSON.parse(outcome.answer.body) as Partial<RelayStatus>;
    status = { signup: body.signup === true, intranet: body.intranet === true };
    notify();
  } catch {
    // Unread; the wording stays the plain "blocked" one.
  }
  return status;
}

function relayOff(key: string): boolean {
  const until = load().off[key];
  return typeof until === "number" && until > clock();
}

// ---------------------------------------------------------------------------
// The budget (R1.6).

function prune(now: number): number[] {
  const held = load();
  held.sent = held.sent.filter((at) => now - at < DAY_MS);
  return held.sent;
}

function withinBudget(now: number): boolean {
  const sent = prune(now);
  if (sent.length >= RELAY_DAILY_LIMIT) return false;
  return sent.filter((at) => now - at < HOUR_MS).length < RELAY_HOURLY_LIMIT;
}

function countAttempt(now: number): void {
  prune(now).push(now);
  save();
}

// ---------------------------------------------------------------------------
// The install id the backend reads on relay sign-up: advisory, used only to
// make a sign-up dearer (R3.5). Sent only through the relay.

export function relayInstallId(): string {
  try {
    const held = storage()?.getItem(INSTALL_KEY);
    if (held && /^[A-Za-z0-9-]{8,64}$/.test(held)) return held;
    const fresh = crypto.randomUUID();
    storage()?.setItem(INSTALL_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

export function relayInstallHeaders(): Record<string, string> {
  return { "X-Neoxify-Install-Id": relayInstallId() };
}

// ---------------------------------------------------------------------------
// Sending.

/** One relay decision at a time (R1.6): every call waits for the one
 * before it, its gate and budget checked when its turn comes. */
let chain: Promise<unknown> = Promise.resolve();

function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

/** The gate (R1.5): "down" -- the tunnel is down, as its owner reports
 * it now, and no connect is under way -- is the only state that opens it.
 * "up" is a tunnel up or being brought up; anything else -- no reader, an
 * error, slow to say -- is "unknown", and keeps it closed too. */
async function tunnelState(): Promise<"down" | "up" | "unknown"> {
  if (ladderPass.inFlight()) return "up";
  const reader = tunnelReader;
  if (reader === null) return "unknown";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const up = await Promise.race([
      reader(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TUNNEL_READ_MS);
      }),
    ]);
    if (up === true || ladderPass.inFlight()) return "up";
    return up === false ? "down" : "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

function errorText(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : "";
}

function isBackendJson(answer: RelayAnswer): boolean {
  return answer.contentType.toLowerCase().includes("application/json");
}

function refusedForRegion(answer: RelayAnswer): boolean {
  if (answer.status !== 403 || !isBackendJson(answer)) return false;
  try {
    return (JSON.parse(answer.body) as { code?: unknown }).code === "RELAY_REGION";
  } catch {
    return false;
  }
}

function boxOrder(entries: LastResortEntry[]): LastResortEntry[] {
  const good = entries.find((entry) => entry.url === lastGoodBox);
  const rest = entries.filter((entry) => entry !== good);
  return (good ? [good, ...rest] : rest).slice(0, RELAY_MAX_BOXES);
}

function noteFailure(): void {
  failures += 1;
  if (failures >= FAILURES_TO_END) endRelayMode();
}

async function send(call: RelayCall, entries: LastResortEntry[], key: string): Promise<RelayOutcome> {
  const started = clock();
  const deadline = started + RELAY_CALL_MS;
  for (const box of boxOrder(entries)) {
    // Checked at send time, before each box: a connect started while the
    // previous one was being asked closes the gate for the next.
    const tunnel = await tunnelState();
    if (tunnel !== "down") {
      // A tunnel connect ends relay mode (R1.7), whichever app made it.
      if (tunnel === "up") endRelayMode();
      return { kind: "gated" };
    }
    if (!withinBudget(clock())) return { kind: "skipped", reason: "budget" };
    const left = deadline - clock();
    if (left <= 0) break;
    let answer: RelayAnswer;
    try {
      answer = await transport({
        base: box.url,
        pins: box.pins,
        method: call.method,
        path: call.path,
        headers: call.headers ?? {},
        body: call.body ?? null,
        timeoutMs: left,
      });
    } catch (err) {
      const text = errorText(err);
      // Not one of the command's own errors: the command is not in this
      // build (the macOS app registers no relay), so nothing was dialled.
      if (!text.startsWith("relay: ")) return { kind: "skipped", reason: "none" };
      if (CONNECTED.has(text)) countAttempt(clock());
      if (REFUSED_LOCALLY.has(text)) break;
      // A write that may have reached the backend is not sent again: a
      // second sign-up, or a second redeem, is not the same as the first.
      if (call.method !== "GET" && !UNDELIVERED.has(text)) break;
      continue;
    }
    countAttempt(clock());
    if (!isBackendJson(answer)) {
      // The box answered, the backend did not: a page from in front of
      // it. Something replied, so it is the answer; it is not one that
      // starts or extends relay mode.
      noteFailure();
      return { kind: "answered", answer };
    }
    lastGoodBox = box.url;
    failures = 0;
    const held = load();
    if (refusedForRegion(answer)) {
      // The backend places this network outside Iran: the relay is not
      // for it, and is not tried here again for a day.
      held.off[key] = clock() + RELAY_REGION_OFF_MS;
      delete held.mode[key];
      status = null;
    } else {
      if (!(typeof held.mode[key] === "number" && held.mode[key] > clock())) lastNormalProbe = clock();
      held.mode[key] = clock() + RELAY_MODE_MS;
    }
    save();
    notify();
    return { kind: "answered", answer };
  }
  noteFailure();
  return { kind: "unanswered" };
}

/** Sends `call` through the relay, if every condition holds; see the top of
 * this file for them, in order. Never throws. */
export async function relayRequest(call: RelayCall, use: RelayUse): Promise<RelayOutcome> {
  try {
    if (!relayAllows(call.method, call.path)) return { kind: "skipped", reason: "path" };
    if (!relaySupported()) return { kind: "skipped", reason: "none" };
    const entries = await lastResortEntries();
    if (entries.length === 0) return { kind: "skipped", reason: "none" };
    const key = networkKey();
    if (relayOff(key)) return { kind: "skipped", reason: "off" };
    if (!iranEvidence()) return { kind: "skipped", reason: "not-iran" };
    const consent = await consentFor(use);
    if (consent !== "granted") return { kind: "skipped", reason: consent };
    return await serially(() => send(call, entries, key));
  } catch {
    // Nothing above dials anything, and `send` answers for its own
    // failures: whatever threw, the relay was not asked.
    return { kind: "skipped", reason: "none" };
  }
}

/** Whether a relay sign-up can be offered on this device now, before any
 * byte is sent: the bundle names a relay, the device looks to be in Iran,
 * the customer has not said no, and the relay is not off here. Consent is
 * still asked when the sign-up is sent. */
export async function relaySignupOffered(): Promise<boolean> {
  try {
    if (!relaySupported()) return false;
    if ((await lastResortEntries()).length === 0) return false;
    if (relayOff(networkKey())) return false;
    if (relayConsent() === "declined") return false;
    return iranEvidence();
  } catch {
    return false;
  }
}

/** For tests: a fresh run with an empty store, a fixed clock and a fake
 * transport, environment and tunnel. */
export function resetLastResortForTests(options: {
  now?: () => number;
  transport?: Transport;
  environment?: Environment;
  tunnelUp?: TunnelReader | null;
} = {}): void {
  state = null;
  failures = 0;
  lastNormalProbe = 0;
  lastGoodBox = null;
  status = null;
  asker = null;
  asking = null;
  chain = Promise.resolve();
  listeners.clear();
  clock = options.now ?? (() => Date.now());
  transport = options.transport ?? ((args) => invoke<RelayAnswer>("relay_request", args));
  environment = options.environment ? () => options.environment! : defaultEnvironment;
  tunnelReader = options.tunnelUp === undefined ? null : options.tunnelUp;
  try {
    storage()?.removeItem(STATE_KEY);
    storage()?.removeItem(CONSENT_KEY);
  } catch {
    // Nothing held.
  }
}
