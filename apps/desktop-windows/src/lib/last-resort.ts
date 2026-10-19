import { invoke } from "@tauri-apps/api/core";
import type { LastResortEntry } from "./endpoint-bundle";
import { lastResortEntries, maybeRefreshBundleThroughRelay } from "./endpoint-bundle-store";
import { ladderPass } from "./ladder-pass";
import { networkKeyFromAsn } from "./network-identity";
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
 *     said the caller is not in Iran (R1.7: 24 hours). That answer is the
 *     only word on where the device is: the backend checks the region of
 *     every relay call itself.
 *  4. The customer has not turned the backup route off in Settings. It is
 *     on until they do, and nothing is asked first.
 *  5. At send time, one call at a time: the tunnel is down and no connect
 *     is under way (R1.5), and the device budget has room (R1.6).
 *
 * Until 2026-10-18 the app also asked consent before the first call
 * (R1.4) and looked for its own evidence of Iran (R1.3) -- the server's
 * last country stamp, or the phone's time zone. Both kept the relay from
 * the customers it is for. A stamp taken while another VPN was on named
 * that VPN's country, and with every route blocked on the customer's own
 * network no new stamp could come, so the relay stayed shut for them; a
 * background refresh never asked consent, so a customer who had not
 * tapped anything yet got nothing. The owner dropped both: the backend's
 * region gate decides, and a refusal switches the relay off here for a
 * day, which is the whole cost of a wrong guess abroad.
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
  /** The customer turned the backup route off in Settings. */
  | "declined"
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

/** The Settings switch: "off" when the customer turned the backup route
 * off, absent otherwise. A new key, not the old consent's
 * ("neoxify.relay.consent"): a "no" given to the prompt -- often before
 * the customer knew what it was for -- would otherwise keep the relay
 * shut on that install for good. */
const SWITCH_KEY = "neoxify.relay.switch";
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
// own: a private window or cleared storage forgets the Settings switch
// (back on) and the budget (which the backend's caps back up).

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
// Seams: the clock, the transport and the tunnel's state are set by the
// app (App.tsx in each client) and by tests.

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

/** Whether a tunnel is up: true, false, or null when it cannot be told. */
type TunnelReader = () => Promise<boolean | null>;
let tunnelReader: TunnelReader | null = null;

/** Tells this file how to ask whether a tunnel is up. Set once by each
 * app at start (App.tsx). A build that never sets it -- the web portal,
 * which shares these screens and has no tunnel and no relay command --
 * has no relay at all (`relaySupported`). */
export function setRelayTunnelReader(reader: TunnelReader | null): void {
  tunnelReader = reader;
  watchPassEnds(reader !== null);
}

/** The unsubscribe from `ladderPass.onEnd`, while there is a tunnel to
 * read. Each connect pass that ends looks for the tunnel it may have left
 * up (`checkTunnelForRelayMode`): on the phone nothing else tells this
 * file a connect landed. */
let offPassEnd: (() => void) | null = null;

function watchPassEnds(on: boolean): void {
  offPassEnd?.();
  offPassEnd = on ? ladderPass.onEnd(() => void checkTunnelForRelayMode()) : null;
}

/** Whether this build can use the relay of last resort at all: a Tauri
 * app that has said how to read its tunnel. The screens hide the relay's
 * switch where it cannot. */
export function relaySupported(): boolean {
  return tunnelReader !== null;
}

// ---------------------------------------------------------------------------
// The customer's switch.

/** Whether the backup route is on: true unless the customer turned it
 * off in Settings. Nothing asks first (see the top of this file). */
export function backupRouteOn(): boolean {
  try {
    return storage()?.getItem(SWITCH_KEY) !== "off";
  } catch {
    return true;
  }
}

/** The Settings switch. Turning it off ends relay mode at once. */
export function setBackupRouteOn(on: boolean): void {
  try {
    if (on) storage()?.removeItem(SWITCH_KEY);
    else storage()?.setItem(SWITCH_KEY, "off");
  } catch {
    // Held as it was; nothing is sent differently until it can be stored.
  }
  if (!on) endRelayMode();
  notify();
}

// ---------------------------------------------------------------------------
// Which network the device is on.

/** The key the relay's per-network memories use. The carrier, as the
 * endpoint demotions key it, or one shared bucket when unknown. */
function networkKey(): string {
  try {
    return networkKeyFromAsn(clock()) ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Relay mode (R1.7), and what the screens show while it lasts.

let failures = 0;
let lastNormalProbe = 0;
let lastGoodBox: string | null = null;
/** Answers on the ordinary routes so far (`noteNormalRouteAnswered`). A
 * relay call made before one does not start or extend relay mode with
 * its own answer: the ordinary routes were found working while it
 * waited its turn, or was on its way. */
let normalAnswers = 0;

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

/** Calls `listener` whenever relay mode, the Settings switch or the relay's status
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
  // ended for good once the tunnel is found up (`checkTunnelForRelayMode`,
  // as the pass ends) or the relay is next asked (`send`).
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

/** How often the backup-route chip, while it shows, looks for a tunnel
 * (`checkTunnelForRelayMode`). */
export const TUNNEL_WATCH_MS = 5_000;

/** Ends relay mode if a tunnel is up, or being brought up, now (R1.7).
 *
 * For the tunnels nothing else here hears of. The Windows dashboard tells
 * the endpoint order the server it dials (`setTunnelServer`), which ends
 * relay mode; the phone has no such call, and on either a tunnel can be up
 * with no pass in this app at all -- a quick-settings tile, always-on VPN,
 * one kept up across a restart. Asked as each connect pass ends, and by
 * the chip while it shows. A tunnel that cannot be read leaves relay mode
 * as it was. Never throws. */
export async function checkTunnelForRelayMode(): Promise<void> {
  try {
    if (Object.keys(load().mode).length === 0) return;
    if ((await tunnelState()) === "up") endRelayMode();
  } catch {
    // Looked at again at the next pass's end, or the chip's next look.
  }
}

/** Called by api.ts whenever the backend answers on an ordinary route:
 * whatever relay mode held, the usual way works again. */
export function noteNormalRouteAnswered(): void {
  normalAnswers += 1;
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

/** Whether the backend placed this network outside Iran. Only
 * RELAY_REGION says so: RELAY_REGION_UNKNOWN is a sign-up refused on a
 * network the backend's table cannot place -- one it still lets sign in,
 * refresh and redeem -- and switches nothing off. */
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

async function send(call: RelayCall, entries: LastResortEntry[], key: string, since: number): Promise<RelayOutcome> {
  // Checked again at its turn: a call queued behind one the backend
  // refused for its region passed `relayRequest`'s check before that
  // answer came, and would otherwise still dial.
  if (relayOff(key)) return { kind: "skipped", reason: "off" };
  const started = clock();
  const deadline = started + RELAY_CALL_MS;
  for (const box of boxOrder(entries)) {
    // And the customer's word, before each box: the switch in Settings
    // turned off while this call waited, or was on its first box.
    if (!backupRouteOn()) return { kind: "skipped", reason: "declined" };
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
    const outsideRegion = refusedForRegion(answer);
    if (outsideRegion) {
      // The backend places this network outside Iran: the relay is not
      // for it, and is not tried here again for a day.
      held.off[key] = clock() + RELAY_REGION_OFF_MS;
      delete held.mode[key];
      status = null;
    } else if (normalAnswers === since && backupRouteOn()) {
      // Not after the ordinary routes answered, or the switch was turned
      // off, while this call was out: either ended relay mode, and an
      // answer to a call made before must not start it again.
      if (!(typeof held.mode[key] === "number" && held.mode[key] > clock())) lastNormalProbe = clock();
      held.mode[key] = clock() + RELAY_MODE_MS;
    }
    save();
    notify();
    if (!outsideRegion) listsThroughRelay();
    return { kind: "answered", answer };
  }
  noteFailure();
  return { kind: "unanswered" };
}

/** One of the endpoint lists, through the relay, as
 * `maybeRefreshBundleThroughRelay` asks for it: a background call, held to
 * every rule above. Anything but the backend's own 200 is nothing to
 * adopt, and the list's signature is checked as it would be from anywhere
 * else. */
async function relayListFetch(path: string): Promise<{ ok: boolean; text: () => Promise<string> }> {
  const outcome = await relayRequest({ method: "GET", path }, "background");
  if (outcome.kind !== "answered") return { ok: false, text: () => Promise.resolve("") };
  const answer = outcome.answer;
  return { ok: answer.status === 200 && isBackendJson(answer), text: () => Promise.resolve(answer.body) };
}

/** Asks for the endpoint lists through the relay once the backend has
 * answered here, while no ordinary route has this run: otherwise a client
 * the relay alone reaches never learns a new host, nor a rotated box
 * (endpoint-bundle-store.ts says when, and once a run). Not awaited -- its
 * calls queue behind this one (`serially`), which waiting here would wait
 * for -- and never throws. */
function listsThroughRelay(): void {
  if (normalAnswers > 0) return;
  try {
    void maybeRefreshBundleThroughRelay(relayListFetch).catch(() => undefined);
  } catch {
    // The answer this follows is delivered whatever happens here.
  }
}

/** Sends `call` through the relay, if every condition holds; see the top of
 * this file for them, in order. Never throws.
 *
 * `_use` is how a request opts in (api.ts) and says what kind it is. It
 * no longer changes anything here: a background request -- the server
 * list, the account, a refresh on resume -- goes the same way as one the
 * customer just asked for, which is what kept signed-in customers on
 * their cached servers while the prompt waited for a tap that never came. */
export async function relayRequest(call: RelayCall, _use: RelayUse): Promise<RelayOutcome> {
  const since = normalAnswers;
  try {
    if (!relayAllows(call.method, call.path)) return { kind: "skipped", reason: "path" };
    if (!relaySupported()) return { kind: "skipped", reason: "none" };
    const entries = await lastResortEntries();
    if (entries.length === 0) return { kind: "skipped", reason: "none" };
    const key = networkKey();
    if (relayOff(key)) return { kind: "skipped", reason: "off" };
    if (!backupRouteOn()) return { kind: "skipped", reason: "declined" };
    return await serially(() => send(call, entries, key, since));
  } catch {
    // Nothing above dials anything, and `send` answers for its own
    // failures: whatever threw, the relay was not asked.
    return { kind: "skipped", reason: "none" };
  }
}

/** Whether a relay sign-up can be offered on this device now, before any
 * byte is sent: the bundle names a relay, the backup route is on, and the
 * backend has not refused this network for its region. */
export async function relaySignupOffered(): Promise<boolean> {
  try {
    if (!relaySupported()) return false;
    if ((await lastResortEntries()).length === 0) return false;
    if (relayOff(networkKey())) return false;
    return backupRouteOn();
  } catch {
    return false;
  }
}

/** For tests: a fresh run with an empty store, a fixed clock and a fake
 * transport and tunnel. */
export function resetLastResortForTests(options: {
  now?: () => number;
  transport?: Transport;
  tunnelUp?: TunnelReader | null;
} = {}): void {
  state = null;
  failures = 0;
  lastNormalProbe = 0;
  lastGoodBox = null;
  normalAnswers = 0;
  status = null;
  chain = Promise.resolve();
  listeners.clear();
  clock = options.now ?? (() => Date.now());
  transport = options.transport ?? ((args) => invoke<RelayAnswer>("relay_request", args));
  tunnelReader = options.tunnelUp === undefined ? null : options.tunnelUp;
  watchPassEnds(tunnelReader !== null);
  try {
    storage()?.removeItem(STATE_KEY);
    storage()?.removeItem(SWITCH_KEY);
  } catch {
    // Nothing held.
  }
}
