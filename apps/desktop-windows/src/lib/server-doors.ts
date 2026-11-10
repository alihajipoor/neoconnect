import { invoke } from "@tauri-apps/api/core";
import { DOUBTFUL_STATUSES } from "./backend-answer";
import { knownDoors } from "./door-list";
import {
  beginDoorAttempt,
  settleDoorAttempt,
  withdrawDoorAttempt,
  type DoorAttempt,
  type EndpointTrace,
} from "./endpoint-trace";
import { ladderPass } from "./ladder-pass";
import { relaySupported, tunnelState, type RelayAnswer } from "./last-resort";
import { networkKeyFromAsn } from "./network-identity";
import type { ServerDoor } from "./types";

/** Every VPN server as a door to the API, by address: when no name of
 * ours answers, the app's own calls sent to a server it already holds
 * credentials for (docs/reachability.md, "Server doors").
 *
 * The API is reached by name, and names are what a filter poisons or
 * resets while the servers' own addresses stay reachable. Each server
 * already answers `/api` on its own address -- it is the mirror the app
 * reaches by name today -- and the backend hands out, with the server
 * list, what it takes to trust that without the name (`ServerDoor` in
 * types.ts; door-list.ts keeps the ones in hand).
 *
 * This file decides *whether* a call goes to a door, to which, and what
 * is remembered about it. How one is sent -- by address, under the door's
 * server name or none, accepted by SPKI pin alone -- is the Rust
 * command's (src-tauri/src/door_http.rs). When a request turns to the
 * doors is api.ts's (`withLastResort`): the owner's order is names first
 * for everyone, doors only once the names have failed in the way only
 * blocking explains, and the relay of last resort after the doors.
 *
 * A door carries the whole API, as the mirror by name does: no list of
 * calls, no region, no allowance to spend. What it is held to:
 *
 *  1. Never with a tunnel up, or one being brought up. With a tunnel
 *     nothing changes: the names are asked through it, as before.
 *  2. A bounded number, in a bounded time: `DOOR_MAX_TRIES` doors for one
 *     call, `DOOR_CALL_MS` in all. First the server this device last
 *     connected through on this network, then the door that last
 *     answered here, then the rest; one that has just failed goes to the
 *     back.
 *  3. A write is never sent twice. A door that could not be connected to,
 *     or whose key was not the pinned one, was sent nothing, and the
 *     next may be asked whatever the call. Once a write has gone out, no
 *     other door is asked, and api.ts asks nobody else either.
 *  4. Where doors have all just failed, they are left alone on that
 *     network for `DOOR_REST_MS`, and for twice as long each time they
 *     fail again, so a network that drops everything -- where the relay
 *     is what answers -- costs a request the wait now and then, not
 *     every time.
 *
 * A door that answers is remembered per network for `DOOR_MODE_MS`
 * ("doors work here"): requests then go to the doors first, and the names
 * are asked again in the background every `NAMES_PROBE_MS`
 * (`namesProbeDue`). A name answering ends it at once
 * (`noteNameAnswered`), and so does a tunnel.
 *
 * "Answers" there means what it means for an address by name: the
 * backend's JSON in any status but 401, 403 and 404, which a server whose
 * mirror points at something else gives to everything
 * (`DOUBTFUL_STATUSES`). Such an answer is still handed back -- it is
 * usually the backend saying a token has expired -- but nothing is
 * remembered on the strength of it, and api.ts does not end a session on
 * a door's word until the door has shown it reaches the backend
 * (`refusedThroughDoorByBackend` there).
 */

export interface DoorCall {
  /** Upper case. */
  method: string;
  /** Relative to `/api`. */
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** The caller's own deadline, when it has one. */
  signal?: AbortSignal | null;
  /** Given for a write that must not arrive twice, and absent for a read
   * or a write that may safely be sent again: whether a page with this
   * status may have come after the backend acted on the request
   * (`mayHaveReachedBackend` in api.ts). */
  mayHaveArrived?: (status: number) => boolean;
  /** Ask this door alone (`address:port`, as an answer names it), where
   * the question is about that door: the health check api.ts asks before
   * it believes a door that refused to renew a session. Whatever the
   * doors' rest on this network, and nothing about the network is
   * concluded from it. */
  only?: string;
}

export type DoorOutcome =
  /** The backend's own answer, through a door -- or, for a write that
   * must not arrive twice, a page that says it may already have. `door`
   * is which one (`address:port`). */
  | { kind: "answered"; answer: RelayAnswer; door: string }
  /** Doors were asked and none gave the backend's answer. `spent`: a
   * write went out through one and may have arrived, so it is not to be
   * sent anywhere else. */
  | { kind: "unanswered"; spent: boolean }
  /** A tunnel is up or being brought up: no door was dialled. */
  | { kind: "gated" }
  /** No door was dialled: none is held, they are being left alone on this
   * network, or this build has none. */
  | { kind: "skipped" };

/** At most this many doors for one call. */
export const DOOR_MAX_TRIES = 3;
/** All the time one call may take across its doors. The command gives
 * each four seconds to connect, so three that never connect fit. */
export const DOOR_CALL_MS = 12_000;
/** How long requests go to the doors first after one answered, per
 * network: as long as relay mode lasts (last-resort.ts). */
export const DOOR_MODE_MS = 15 * 60_000;
/** While they do, how often the names are asked again in the background. */
export const NAMES_PROBE_MS = 3 * 60_000;
/** How long the doors are left alone on a network where every one asked
 * has just failed: this the first time, doubling each time they fail
 * again there, up to `DOOR_REST_MAX_MS`. */
export const DOOR_REST_MS = 2 * 60_000;
export const DOOR_REST_MAX_MS = 16 * 60_000;
/** How long a door that failed is asked after the others. */
const DOOR_FAILED_MS = 10 * 60_000;
/** Going to the doors first ends after this many calls in a row that no
 * door answered. */
const FAILURES_TO_END = 2;
/** How many networks' memories are kept. */
const MAX_NETWORKS = 16;

const STATE_KEY = "neoxify.doors";

/** Errors from the command (`DoorError` in door_http.rs) after which the
 * request is known not to have left this machine: `undelivered` there,
 * which server-doors.test.ts reads to keep the two alike. */
export const UNDELIVERED: ReadonlySet<string> = new Set([
  "door: bad-door",
  "door: bad-pins",
  "door: bad-request",
  "door: pin-mismatch",
  "door: tls",
  "door: connect-timeout",
  "door: connect",
]);

const SKIPPED: DoorOutcome = { kind: "skipped" };

// ---------------------------------------------------------------------------
// Storage: per device and best-effort, as the relay's is.

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

interface Persisted {
  /** Network key -> until when requests go to the doors first there. */
  mode: Record<string, number>;
  /** Network key -> the door (`address:port`) that last answered there. */
  good: Record<string, string>;
  /** Network key -> the addresses of the server this device last
   * connected through there. */
  server: Record<string, string[]>;
}

let state: Persisted | null = null;

function record<T>(value: unknown, keep: (entry: unknown) => entry is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (value === null || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value)) if (keep(entry)) out[key] = entry;
  return out;
}

const isNumber = (entry: unknown): entry is number => typeof entry === "number";
const isString = (entry: unknown): entry is string => typeof entry === "string";
const isStrings = (entry: unknown): entry is string[] => Array.isArray(entry) && entry.every(isString);

function load(): Persisted {
  if (state) return state;
  let parsed: Partial<Persisted> = {};
  try {
    const raw = storage()?.getItem(STATE_KEY);
    if (raw) parsed = (JSON.parse(raw) ?? {}) as Partial<Persisted>;
  } catch {
    parsed = {};
  }
  state = {
    mode: record(parsed.mode, isNumber),
    good: record(parsed.good, isString),
    server: record(parsed.server, isStrings),
  };
  return state;
}

/** Drops the oldest networks past `MAX_NETWORKS`: a device that roams
 * must not grow this without end. */
function bounded<T>(held: Record<string, T>): Record<string, T> {
  const entries = Object.entries(held);
  return entries.length <= MAX_NETWORKS ? held : Object.fromEntries(entries.slice(entries.length - MAX_NETWORKS));
}

function save(): void {
  const held = load();
  const now = clock();
  held.mode = Object.fromEntries(Object.entries(held.mode).filter(([, until]) => until > now));
  held.good = bounded(held.good);
  held.server = bounded(held.server);
  try {
    storage()?.setItem(STATE_KEY, JSON.stringify(held));
  } catch {
    // Held in memory for this run.
  }
}

/** Puts `key` last, as the newest, so `bounded` drops the others first. */
function put<T>(held: Record<string, T>, key: string, value: T): void {
  delete held[key];
  held[key] = value;
}

// ---------------------------------------------------------------------------
// Seams: the clock and the transport are set by tests.

let clock: () => number = () => Date.now();

type Transport = (args: {
  host: string;
  port: number;
  pins: string[];
  sni: string | null;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}) => Promise<RelayAnswer>;

const command: Transport = (args) => invoke<RelayAnswer>("door_request", args);
let transport: Transport = command;

/** The key the per-network memories use: the carrier, as the relay's and
 * the endpoint demotions key theirs, or one shared bucket when unknown. */
function networkKey(): string {
  try {
    return networkKeyFromAsn(clock()) ?? "unknown";
  } catch {
    return "unknown";
  }
}

const doorKey = (door: ServerDoor): string => `${door.host}:${door.port}`;

// ---------------------------------------------------------------------------
// What this run has found out about each door and each network.

/** Calls in a row, while doors go first, that no door answered. */
let failures = 0;
/** When the names were last asked in the background (`namesProbeDue`). */
let lastNamesProbe = 0;
/** Answers by name so far (`noteNameAnswered`). A door's answer to a call
 * made before one does not start "doors first": the names were found
 * working while it was out. */
let nameAnswers = 0;
/** Door -> when it last failed, until it answers again. */
const failedAt = new Map<string, number>();
/** Doors the command refused as malformed, with the pins they had: not
 * offered again until the list brings them back different. */
const unusable = new Set<string>();
/** Network key -> until when the doors are left alone there, and how
 * long the rest was that ends then. */
const rests = new Map<string, { until: number; span: number }>();
/** Whether this build turned out to have no door command (`send`). */
let noCommand = false;

function modeHolds(key: string): boolean {
  const until = load().mode[key];
  return typeof until === "number" && until > clock();
}

/** Whether requests go to the doors before the names on this network
 * now: a door answered here in the last fifteen minutes, nothing has
 * ended that since, and no connect is under way. */
export function askDoorsFirst(): boolean {
  if (ladderPass.inFlight()) return false;
  return modeHolds(networkKey());
}

/** Whether the names are due to be asked again in the background, while
 * requests go to the doors first. Answers true once each
 * `NAMES_PROBE_MS` and counts that as the asking: api.ts sends the health
 * check to the names on its own and waits for nothing, and an answer
 * there ends "doors first" (`noteNameAnswered`). */
export function namesProbeDue(): boolean {
  if (!askDoorsFirst()) return false;
  const now = clock();
  if (now - lastNamesProbe < NAMES_PROBE_MS) return false;
  lastNamesProbe = now;
  return true;
}

/** Ends "doors first" on every network: a name answered, or a tunnel is
 * up or being dialled. */
export function endDoorMode(): void {
  const held = load();
  failures = 0;
  if (Object.keys(held.mode).length === 0) return;
  held.mode = {};
  save();
}

/** Called by api.ts whenever the backend answers at an address by name:
 * the usual way works, and the doors are not needed. */
export function noteNameAnswered(): void {
  nameAnswers += 1;
  endDoorMode();
}

/** Looks at the tunnel as a connect pass ends. Up: "doors first" is over
 * (nothing is sent around a tunnel), and the server the pass landed on is
 * remembered as the one this device last connected through on this
 * network -- its door is asked first the next time the names fail here
 * (`ordered`). Never throws. */
export async function noteTunnelForDoors(): Promise<void> {
  try {
    if ((await tunnelState()) !== "up") return;
    endDoorMode();
    const server = ladderPass.tunnelServer.current;
    if (!server) return;
    const addresses = [...server.addresses].filter(isString).slice(0, 4);
    if (addresses.length === 0) return;
    put(load().server, networkKey(), addresses);
    save();
  } catch {
    // Looked at again when the next pass ends.
  }
}

// On the phone nothing else says a connect landed; on Windows the
// dashboard also says which server it dials (`setTunnelServer` in
// api-endpoints.ts, which ends "doors first" as it ends relay mode).
ladderPass.onEnd(() => void noteTunnelForDoors());

/** The doors to ask, best first: the server this device last connected
 * through on this network, the door that last answered here, the rest in
 * the list's order -- and after all of those, the ones that failed in the
 * last ten minutes, longest ago first. A malformed door is left out. */
function ordered(doors: ServerDoor[], key: string): ServerDoor[] {
  const held = load();
  const now = clock();
  const connected = held.server[key] ?? [];
  const good = held.good[key];
  const failed = (door: ServerDoor): number | null => {
    const at = failedAt.get(doorKey(door));
    return at !== undefined && now - at < DOOR_FAILED_MS && now >= at ? at : null;
  };
  const rank = (door: ServerDoor): number => {
    if (failed(door) !== null) return 3;
    if (connected.includes(door.host)) return 0;
    return doorKey(door) === good ? 1 : 2;
  };
  return doors
    .filter((door) => !unusable.has(`${doorKey(door)}|${door.pins.join(",")}`))
    .map((door, at) => ({ door, at }))
    .sort((a, b) => rank(a.door) - rank(b.door) || (failed(a.door) ?? 0) - (failed(b.door) ?? 0) || a.at - b.at)
    .map((entry) => entry.door);
}

/** The backend answered through `door`. */
function noteAnswered(door: ServerDoor, key: string, since: number): void {
  failedAt.delete(doorKey(door));
  failures = 0;
  rests.delete(key);
  const held = load();
  put(held.good, key, doorKey(door));
  // Not after a name answered while this call was out: that ended "doors
  // first", and an answer to a call made before must not start it again.
  if (nameAnswers === since) {
    if (!modeHolds(key)) lastNamesProbe = clock();
    held.mode[key] = clock() + DOOR_MODE_MS;
  }
  save();
}

/** Doors were asked for one call and none gave the backend's answer.
 * While doors go first, the first such call is forgiven; otherwise the
 * doors are left alone here for a while. */
function noteUnanswered(key: string): void {
  if (modeHolds(key)) {
    failures += 1;
    if (failures < FAILURES_TO_END) return;
    delete load().mode[key];
    save();
  }
  failures = 0;
  const last = rests.get(key);
  const span = last === undefined ? DOOR_REST_MS : Math.min(last.span * 2, DOOR_REST_MAX_MS);
  rests.set(key, { until: clock() + span, span });
}

function resting(key: string): boolean {
  const rest = rests.get(key);
  return rest !== undefined && rest.until > clock();
}

// ---------------------------------------------------------------------------
// Sending.

/** While no door is known to answer here, one call at a time finds out:
 * a screen's reads fail together, and each asking the same doors at once
 * would be a burst of handshakes to one server for nothing. Once one
 * answers, calls go to it side by side. */
let chain: Promise<unknown> = Promise.resolve();

function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

const ABANDONED = Symbol("abandoned");

/** `work`, no longer waited for once `signal` fires. The call itself is
 * not cancelled -- the command runs to its own timeout -- only given up
 * on, as a body is in api.ts (`readWithin`). */
function unlessAbandoned<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T | typeof ABANDONED> {
  if (!signal) return work;
  return new Promise<T | typeof ABANDONED>((resolve, reject) => {
    const onAbort = () => resolve(ABANDONED);
    if (signal.aborted) {
      work.catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function errorText(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : "";
}

function isJson(answer: RelayAnswer): boolean {
  return answer.contentType.toLowerCase().includes("application/json");
}

/** Whether an answer through a door is the backend's own: its JSON,
 * whatever the status, or a success with no body and no type (its 204s).
 * Anything else is a page from the server itself -- its mirror cannot
 * reach the API just now -- and another door is asked. */
function backendsOwn(answer: RelayAnswer): boolean {
  if (isJson(answer)) return true;
  return answer.status >= 200 && answer.status < 300 && answer.contentType === "" && answer.body === "";
}

/** Whether an answer that is the backend's own also shows the door
 * reaches the backend: anything but JSON in one of the statuses a server
 * that is not the backend gives to everything. */
function showsBackend(answer: RelayAnswer): boolean {
  return !(isJson(answer) && DOUBTFUL_STATUSES.has(answer.status));
}

/** Called by api.ts when a door's refusal turned out not to be the
 * backend's -- its health check, asked through that same door, did not
 * get the backend's answer. The door goes behind the others, and is no
 * longer the one that last answered here. */
export function noteDoorNotBackend(door: string): void {
  failedAt.set(door, clock());
  const held = load();
  const key = networkKey();
  if (held.good[key] !== door) return;
  delete held.good[key];
  save();
}

async function send(call: DoorCall, trace: EndpointTrace | undefined, since: number): Promise<DoorOutcome> {
  const key = networkKey();
  const only = call.only;
  // Checked at its turn: a call queued behind one that found every door
  // failing would otherwise ask them all again.
  if (only === undefined && resting(key)) return SKIPPED;
  const held = await knownDoors();
  const doors =
    only === undefined ? ordered(held, key).slice(0, DOOR_MAX_TRIES) : held.filter((door) => doorKey(door) === only);
  if (doors.length === 0) return SKIPPED;
  const once = call.mayHaveArrived !== undefined;
  const deadline = clock() + DOOR_CALL_MS;
  /** Doors that were dialled. */
  let asked = 0;
  for (const door of doors) {
    if (call.signal?.aborted) break;
    // Before each door: a connect begun while the last one was being
    // asked closes the gate for the next.
    const tunnel = await tunnelState();
    if (tunnel !== "down") {
      if (tunnel === "up") endDoorMode();
      return { kind: "gated" };
    }
    const left = deadline - clock();
    if (left <= 0) break;
    const attempt: DoorAttempt | undefined = beginDoorAttempt(trace, doorKey(door), clock());
    let answer: RelayAnswer | typeof ABANDONED;
    try {
      answer = await unlessAbandoned(
        transport({
          host: door.host,
          port: door.port,
          pins: door.pins,
          sni: door.sni,
          method: call.method,
          path: call.path,
          headers: call.headers ?? {},
          body: call.body ?? null,
          timeoutMs: left,
        }),
        call.signal,
      );
    } catch (err) {
      const text = errorText(err);
      // Not one of the command's own errors: the command is not in this
      // build (the macOS app registers none), so nothing was dialled, now
      // or for the rest of this run. Nor for a call the command will not
      // carry at all, which no other door would carry either.
      if (!text.startsWith("door: ") || text === "door: bad-request") {
        if (!text.startsWith("door: ")) noCommand = true;
        withdrawDoorAttempt(trace, attempt);
        return asked > 0 ? { kind: "unanswered", spent: false } : SKIPPED;
      }
      if (text === "door: bad-door" || text === "door: bad-pins") {
        // Refused on this device: the network was not asked.
        settleDoorAttempt(attempt, "bad", clock());
        unusable.add(`${doorKey(door)}|${door.pins.join(",")}`);
        continue;
      }
      asked += 1;
      failedAt.set(doorKey(door), clock());
      settleDoorAttempt(
        attempt,
        text === "door: pin-mismatch"
          ? "pin"
          : text === "door: tls"
            ? "tls"
            : text === "door: connect-timeout" || text === "door: timeout"
              ? "timeout"
              : "net",
        clock(),
      );
      if (UNDELIVERED.has(text)) continue;
      // The request went out and no whole answer came back. A read asks
      // the next door. A write that must not arrive twice ends here: this
      // door may have passed it on. The door took the connection, so
      // nothing is concluded about the network; it goes behind the others.
      if (!once) continue;
      return { kind: "unanswered", spent: true };
    }
    if (answer === ABANDONED) {
      // The caller's own deadline, not the door's failure: the attempt
      // stays pending, which the trace renders as `budget`, and nothing
      // is held against the door. A write may be on its way all the same.
      return { kind: "unanswered", spent: once };
    }
    asked += 1;
    settleDoorAttempt(attempt, `h${answer.status}`, clock());
    if (backendsOwn(answer)) {
      if (showsBackend(answer)) noteAnswered(door, key, since);
      return { kind: "answered", answer, door: doorKey(door) };
    }
    failedAt.set(doorKey(door), clock());
    if (once && call.mayHaveArrived?.(answer.status)) {
      // A gateway page that may have come after the backend acted: the
      // write is not sent on, and this page is its answer.
      return { kind: "answered", answer, door: doorKey(door) };
    }
  }
  if (asked === 0) return SKIPPED;
  if (call.signal?.aborted || only !== undefined) return { kind: "unanswered", spent: false };
  noteUnanswered(key);
  return { kind: "unanswered", spent: false };
}

/** Sends `call` through a server's door, if every condition at the top
 * of this file holds. Never throws.
 *
 * `trace`, when given, is told about each door that was asked and how it
 * ended, and about none that was not (`DoorAttempt` in endpoint-trace.ts). */
export async function doorRequest(call: DoorCall, trace?: EndpointTrace): Promise<DoorOutcome> {
  const since = nameAnswers;
  try {
    // The same builds as the relay: a Tauri app that has said how to read
    // its tunnel. Anything else has no command to send with, and no way
    // to know that no tunnel is up.
    if (!relaySupported() || noCommand) return SKIPPED;
    if (call.signal?.aborted) return SKIPPED;
    const run = () => send(call, trace, since);
    return askDoorsFirst() ? await run() : await serially(run);
  } catch {
    // `send` answers for its own failures; whatever threw, it was before
    // any door was dialled.
    return SKIPPED;
  }
}

/** For tests: a fresh run with an empty store, a fixed clock and a fake
 * transport. */
export function resetServerDoorsForTests(options: { now?: () => number; transport?: Transport } = {}): void {
  state = null;
  failures = 0;
  lastNamesProbe = 0;
  nameAnswers = 0;
  failedAt.clear();
  unusable.clear();
  rests.clear();
  noCommand = false;
  chain = Promise.resolve();
  clock = options.now ?? (() => Date.now());
  transport = options.transport ?? command;
  try {
    storage()?.removeItem(STATE_KEY);
  } catch {
    // Nothing held.
  }
}
