/** "Block the internet while reconnecting" (Windows, opt-in): the app's
 * half of the service's reconnect hold (service/src/engines/reconnect_hold.rs).
 *
 * The service does the blocking. It arms a session connected with the
 * setting on, starts holding the moment that session ends any way but the
 * customer's own Disconnect -- the engine dying, or the app's
 * `vpn_disconnect_for_reconnect` -- and lets go on Disconnect, on the app's
 * `vpn_release_reconnect_hold`, when the setting goes off, when the app
 * goes away, when no reconnect follows a drop within two minutes, after 40
 * minutes with no tunnel, and before a connect it does not cover (IKEv2,
 * Custom mode). Nothing is held while it is off: the default stays fail
 * open.
 *
 * And nothing is offered until a capture has proved it
 * (`RECONNECT_HOLD_PROVEN`).
 *
 * What the app owes it, decided here so it can be tested without a window:
 *
 *  - which teardown a pass uses (`passTeardown`): an automatic pass -- a
 *    reconnect's attempt, the mid-session failover -- and a press made
 *    while the hold is holding keep it through their teardowns; a press
 *    from a quiet screen lets go, as Disconnect always has;
 *  - when to let go (`episodeEndReleases`, `createStatusRelease`): a pass
 *    that landed a tunnel, an episode that ended without one, a drop that
 *    began none -- and, from status reads alone, only a tunnel the service
 *    says landed under the hold, verified, on two reads a second apart;
 *  - what the screen and the notifications say about the customer's other
 *    traffic in the gap (`gapTraffic`, `holdHint`, `holdNote`), from the
 *    service's own facts -- never from the setting alone, and never "going
 *    out without Neoxify" while the service may be blocking it. */

import { invoke } from "@tauri-apps/api/core";
import type { ReconnectPhase, ReconnectStop } from "./auto-reconnect";
import { withTimeout } from "./service-call";

/** Whether "Block the internet while reconnecting" has been proved: false
 * until it has.
 *
 * None of the hold has carried a packet (service/src/engines/
 * reconnect_hold.rs, "What has not been measured"). Until the capture
 * checklist in docs/reconnect-hold-proof.md has passed on Neoxify-Test for
 * every engine -- WireGuard's kernel socket dialling under the hold above
 * all -- and been written up in docs/journal/log.md, it is not a switch a
 * customer can turn on and then be told other connections are blocked. So
 * Settings does not draw it (an unhonoured setting is not drawn), every
 * connect tells the service it is off, and nothing on screen speaks of it.
 * Flipped in a commit of its own. */
export const RECONNECT_HOLD_PROVEN = false;

/** Whether this build offers it: once proved, or in a test installer built
 * for the VM with `VITE_RECONNECT_HOLD=1` (build-test-installer.yml's
 * `reconnect_hold` input). The release workflow never sets it
 * (reconnect-hold.wiring.test.ts). */
export const RECONNECT_HOLD_OFFERED: boolean = RECONNECT_HOLD_PROVEN || import.meta.env.VITE_RECONNECT_HOLD === "1";

/** The setting as the hold acts on it: the customer's preference, in a
 * build that offers it. Every read of the preference that decides what the
 * service holds, or what the screen says about it, goes through this -- a
 * preference saved by a test build is nothing in a release. */
export function holdWanted(preference: boolean): boolean {
  return RECONNECT_HOLD_OFFERED && preference;
}

export type ReconnectHoldProblem = "filtersRefused" | "tunnelNotPermitted" | "timedOut" | "notCovered" | "other";

/** The service's facts: `Response::State.reconnect_hold`. `dnsAnywhere`:
 * the machine's resolvers could not be read, so port 53 to anywhere is
 * let through rather than name lookups to those alone. */
export type ReconnectHold =
  | { readonly state: "armed" }
  | {
      readonly state: "holding";
      readonly heldSecs: number;
      readonly dnsAnywhere?: true;
      /** A tunnel is up that came up after the drop this holds for, the
       * hold's plan its own: the service's word. Never the dropped session,
       * which a status can still call connected while it is taken down
       * (`landedUnderHold`). Absent from an older service. */
      readonly landed?: true;
      /** The drop this holds for was held late: a WireGuard session whose
       * block could not stand in force while it was up (WFP refused it, or
       * its server could not be named), so the block went in on the report
       * of the drop, after wireguard.exe's own had gone -- 0.2 to 0.6 s on
       * the VM in which traffic may have left. The service's word. */
      readonly standingRefused?: true;
    }
  | { readonly state: "notHeld"; readonly problem: ReconnectHoldProblem };

const PROBLEMS: ReadonlySet<string> = new Set(["filtersRefused", "tunnelNotPermitted", "timedOut", "notCovered"]);

/** The field as the service sends it, or null for nothing (the setting
 * off, nothing armed, an older service) and for a shape this app does not
 * know -- which says nothing rather than something wrong. A problem from a
 * newer service is "other". */
export function readHold(raw: unknown): ReconnectHold | null {
  if (raw === null || typeof raw !== "object") return null;
  const field = raw as Record<string, unknown>;
  switch (field.state) {
    case "armed":
      return { state: "armed" };
    case "holding": {
      const secs = field.held_secs;
      return {
        state: "holding",
        heldSecs: typeof secs === "number" && Number.isFinite(secs) && secs >= 0 ? secs : 0,
        ...(field.dns_anywhere === true ? { dnsAnywhere: true as const } : {}),
        ...(field.landed === true ? { landed: true as const } : {}),
        ...(field.standing_refused === true ? { standingRefused: true as const } : {}),
      };
    }
    case "notHeld":
      return {
        state: "notHeld",
        problem: typeof field.problem === "string" && PROBLEMS.has(field.problem) ? (field.problem as ReconnectHoldProblem) : "other",
      };
    default:
      return null;
  }
}

/** Which teardown a pass's own "take down what is up" uses. */
export function passTeardown({
  setting,
  automatic,
  holding,
}: {
  /** "Block the internet while reconnecting" is on. */
  setting: boolean;
  /** A reconnect's attempt, or the mid-session failover. */
  automatic: boolean;
  /** The service last said it is holding. */
  holding: boolean;
}): "keepHold" | "plain" {
  return setting && (automatic || holding) ? "keepHold" : "plain";
}

/** What one status read says that letting go turns on: `VpnStatus`'s
 * fields, as the service sends them. */
export interface HoldStatusRead {
  readonly connected: boolean;
  readonly ipv4Confined?: boolean | null;
  readonly health?: { readonly state: string };
}

/** Whether one status shows a tunnel that has landed under the hold,
 * verified as far as a status can: the service says it landed -- a session
 * up that came up after the drop, its tunnel in the hold's plan, never the
 * dropped one still in the slot -- its engine is up, and the tunnel holds
 * the machine on its own: its IPv4 confinement in (Xray, OpenVPN), or, for
 * a session with no confinement of ours (WireGuard), a fresh handshake.
 *
 * `connected` beside a hold proves nothing by itself. On the VM a read
 * 0.5 s after a drop said connected, holding and not confined at once --
 * the dead session not yet taken down -- and letting go on it ran the
 * whole 26 s reconnect fail-open. */
export function landedUnderHold(hold: ReconnectHold | null, status: HoldStatusRead): boolean {
  if (hold?.state !== "holding" || hold.landed !== true || !status.connected) return false;
  if (status.ipv4Confined === true) return true;
  return (status.ipv4Confined === null || status.ipv4Confined === undefined) && status.health?.state === "alive";
}

/** How far apart the two reads that let go from status alone must be. */
export const RELEASE_READS_APART_MS = 1_000;

/** Letting go of a hold from status reads alone -- the net under the
 * explicit releases (a pass that landed, an episode's end), for a hold the
 * service still reports over a tunnel that is up with no pass of ours
 * keeping it. Never on a single read, and never on a contradictory one:
 * two reads at least `RELEASE_READS_APART_MS` apart, each showing a
 * landed tunnel (`landedUnderHold`) with no pass running, and nothing
 * else between them. Read off the statuses, never the screen's state,
 * which lags the service around a drop. */
export function createStatusRelease(): {
  see(read: { hold: ReconnectHold | null; status: HoldStatusRead; passRunning: boolean; now: number }): boolean;
} {
  let firstAt: number | null = null;
  return {
    see({ hold, status, passRunning, now }) {
      if (passRunning || !landedUnderHold(hold, status)) {
        firstAt = null;
        return false;
      }
      if (firstAt === null) {
        firstAt = now;
        return false;
      }
      if (now - firstAt < RELEASE_READS_APART_MS) return false;
      firstAt = null;
      return true;
    },
  };
}

/** Whether a move of the reconnect's phase lets go of the hold: every end
 * of an episode but a press of the customer's own, whose pass decides
 * (`passTeardown`) -- a Disconnect lets go by itself, and Connect keeps it
 * until it lands or fails.
 *
 * And a drop that began no episode at all: armed straight to idle, on a
 * third quick death, a plan that has stopped, the device limit, a
 * sign-out, Gaming mode. The service began holding the moment that
 * session's engine died, and with nothing going to reconnect it nothing
 * else would let go short of its own backstop. */
export function episodeEndReleases(before: ReconnectPhase, after: ReconnectPhase): boolean {
  if (after.kind === "armed") return running(before);
  if (after.kind !== "idle") return false;
  if (!running(before) && before.kind !== "armed") return false;
  return !PRESSES.has(after.stopped ?? "customer");
}

const PRESSES: ReadonlySet<ReconnectStop> = new Set(["customer"]);

export type HoldNoteKey =
  | "hold.holding"
  | "hold.dnsAnywhere"
  | "hold.heldLate"
  | "hold.filtersRefused"
  | "hold.tunnelNotPermitted"
  | "hold.timedOut"
  | "hold.notCovered"
  | "hold.other";

/** What the main page says about the hold while a reconnect runs or the
 * connection has been lost: holding, or why not. Nothing outside those --
 * the hold is about the gap -- and nothing when the setting is off.
 * Holding with port 53 open to anywhere is said as that, beside the
 * sentence that it holds: "name lookups still go out" would be narrower
 * than what goes out. A hold that went in late is said too, after it:
 * "blocked" is true from then, and not of the moment before. */
export function holdNotes(hold: ReconnectHold | null, { inGap, setting }: { inGap: boolean; setting: boolean }): HoldNoteKey[] {
  if (!setting || !inGap || hold === null) return [];
  if (hold.state === "holding") {
    const notes: HoldNoteKey[] = [hold.dnsAnywhere === true ? "hold.dnsAnywhere" : "hold.holding"];
    if (hold.standingRefused === true) notes.push("hold.heldLate");
    return notes;
  }
  if (hold.state === "notHeld") return [`hold.${hold.problem}`];
  return [];
}

/** The first of `holdNotes`: what the hold is doing, or why it is not. */
export function holdNote(hold: ReconnectHold | null, opts: { inGap: boolean; setting: boolean }): HoldNoteKey | null {
  return holdNotes(hold, opts)[0] ?? null;
}

/** Where the customer's other traffic goes in a gap -- a reconnect
 * running, or a tunnel dropped with nothing reconnecting it -- as far as
 * the service has said. The one source every sentence and notification
 * about it reads (`holdHint`, `notifyStep`):
 *
 *  - `blocked`: the service says it holds the internet;
 *  - `blockedLate`: the same, but it went in on the report of the drop,
 *    not from the moment of it (`standingRefused`): blocked now, and not
 *    to be said of the moment before;
 *  - `unconfirmed`: the setting is on and the service's last word is
 *    "armed" -- it has not yet said the hold is in, or why not. Its drop
 *    not seen yet, or the session's own confinement still standing over a
 *    tunnel whose way out has gone: either way not "going out without
 *    Neoxify", which is false the moment the hold is in -- measured on the
 *    VM, said for 0.25 to 2.3 s while the service already held -- nor
 *    "blocked", which nothing has confirmed;
 *  - `open`: the setting off, nothing armed or held, or the service says
 *    it is not holding and why. */
export type GapTraffic = "blocked" | "blockedLate" | "unconfirmed" | "open";

export function gapTraffic(hold: ReconnectHold | null, setting: boolean): GapTraffic {
  if (!setting || hold === null) return "open";
  if (hold.state === "holding") return hold.standingRefused === true ? "blockedLate" : "blocked";
  if (hold.state === "armed") return "unconfirmed";
  return "open";
}

/** How long the gap waits for the service's word on the hold before it says
 * the word has not come. The service answers within about half a second
 * (the VM, 2026-10-20), and every gap said "checking" and then "blocked" a
 * moment later -- a sentence that changed twice in the first second of
 * every short reconnect. So nothing is said for this long: the hint's room
 * stays empty, reserved (`HOLD_HINTS`), and no notification goes. */
export const HOLD_WORD_GRACE_MS = 1_500;

/** Whether the service's word has been awaited past `HOLD_WORD_GRACE_MS`:
 * `since`, when the gap began waiting for it (null when it is not). */
export function holdWordLate(since: number | null, now: number): boolean {
  return since !== null && now - since >= HOLD_WORD_GRACE_MS;
}

/** `gapTraffic` as it may be said: "unconfirmed" only once the word is late
 * (`holdWordLate`), "pending" before -- nothing said yet. */
export type GapWord = GapTraffic | "pending";

export function gapWord(gap: GapTraffic, wordLate: boolean): GapWord {
  return gap === "unconfirmed" && !wordLate ? "pending" : gap;
}

export type HoldHintKey = "hold.holding" | "hold.heldAfterDrop" | "hold.unconfirmed";

/** Every sentence `holdHint` can put under the line, for the room the
 * hint keeps where the setting can make it say them. */
export const HOLD_HINTS: readonly HoldHintKey[] = ["hold.holding", "hold.heldAfterDrop", "hold.unconfirmed"];

/** The sentence under the state, when the hold is what it has to say
 * (`gapTraffic`).
 *
 * While a reconnect runs -- or a pass waits for a network -- and the
 * service holds: blocked until Neoxify reconnects. After a drop that
 * nothing is reconnecting, while the service still says it holds --
 * between the drop and the release reaching it, or a service that has not
 * answered the release -- blocked until the block is lifted. In the gap
 * with the service's word not in yet: neither -- "pending", nothing at all
 * in the hint's reserved room, until the word is late (`wordLate`, past
 * `HOLD_WORD_GRACE_MS`; a caller that keeps no clock says it is), then
 * "checking". Null leaves the headline's own hint, which says the traffic
 * is going out without Neoxify -- only ever when the service has said
 * nothing is held. */
export function holdHint(
  hold: ReconnectHold | null,
  {
    reconnecting,
    dropped,
    setting,
    wordLate = true,
  }: { reconnecting: boolean; dropped: boolean; setting: boolean; wordLate?: boolean },
): HoldHintKey | "pending" | null {
  if (!reconnecting && !dropped) return null;
  switch (gapWord(gapTraffic(hold, setting), wordLate)) {
    // Late or not, it blocks now; the note says the rest (`holdNotes`).
    case "blocked":
    case "blockedLate":
      return reconnecting ? "hold.holding" : "hold.heldAfterDrop";
    case "unconfirmed":
      return "hold.unconfirmed";
    case "pending":
      return "pending";
    case "open":
      return null;
  }
}

// --- the service's half, and the one answer every screen reads ----------

let held: ReconnectHold | null = null;
const listeners = new Set<() => void>();

/** What the service last said about the hold, for whichever screen is up. */
export const holdStore = {
  current(): ReconnectHold | null {
    return held;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** A status's field, as read. */
  observe(raw: unknown): void {
    const next = readHold(raw);
    if (sameHold(next, held)) return;
    held = next;
    for (const listener of [...listeners]) listener();
  },
  /** For tests. */
  resetForTests(): void {
    held = null;
    listeners.clear();
  },
};

function sameHold(a: ReconnectHold | null, b: ReconnectHold | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.state !== b.state) return false;
  // The seconds held move every poll; only the state and the problem are
  // news.
  if (a.state === "notHeld" && b.state === "notHeld") return a.problem === b.problem;
  if (a.state === "holding" && b.state === "holding") {
    return a.dnsAnywhere === b.dnsAnywhere && a.landed === b.landed && a.standingRefused === b.standingRefused;
  }
  return true;
}

/** How long a press that ended an episode is given to start the pass that
 * decides about the hold, before the hold is let go of anyway. */
export const PRESS_GRACE_MS = 3_000;

function running(phase: ReconnectPhase): boolean {
  return phase.kind === "waiting" || phase.kind === "attempting";
}

/** Lets go of the hold when the episode it was for ends, for as long as
 * the app runs: one per app, like the episode, so it holds whichever
 * screen is up (the main page unmounts whenever Settings opens).
 *
 *  - an episode that landed, or ended any way but a press, and a drop that
 *    began none, let go at once (`episodeEndReleases`) -- the gap is over,
 *    or nothing will close it;
 *  - one a press ended is the press's: its pass keeps the hold until it
 *    lands or fails. If no pass is running `PRESS_GRACE_MS` later -- a
 *    location picked and then nothing dialled -- it lets go then. The
 *    same for a press over an armed tunnel the service had begun holding
 *    for before the screen heard of the drop;
 *  - an episode that begins tells the service a reconnect follows
 *    (`keep`), so its backstop for a drop nothing follows does not let go
 *    while this one waits for a network before its first dial.
 *
 * Only while the setting is on: with it off the service holds nothing,
 * and nothing is asked. Returns the stop. */
export function watchEpisodesForHold(deps: {
  phase: () => ReconnectPhase;
  subscribe: (listener: () => void) => () => void;
  setting: () => boolean;
  passRunning: () => boolean;
  release: () => Promise<unknown>;
  keep: () => Promise<unknown>;
  later?: (fn: () => void, ms: number) => unknown;
}): () => void {
  const later = deps.later ?? ((fn, ms) => setTimeout(fn, ms));
  let before = deps.phase();
  return deps.subscribe(() => {
    const after = deps.phase();
    const prev = before;
    before = after;
    if (!deps.setting() || prev === after) return;
    if (episodeEndReleases(prev, after)) {
      void deps.release();
      return;
    }
    if (!running(prev) && running(after)) {
      void deps.keep();
      return;
    }
    if ((running(prev) || prev.kind === "armed") && after.kind === "idle") {
      later(() => {
        if (!deps.setting() || deps.passRunning() || running(deps.phase())) return;
        void deps.release();
      }, PRESS_GRACE_MS);
    }
  });
}

/** The pauses between asking again while a release has not been
 * confirmed: about a quarter of a minute in all. The service's own
 * backstop (two minutes with no reconnect after a drop) and the app going
 * away are behind it. */
export const RELEASE_RETRY_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

/** Asks the service to let go, and asks again until a status says it no
 * longer holds -- not fire and forget: a release lost to a busy pipe or a
 * timed-out call would leave the machine held, and an app that runs is
 * never silent for the service to notice (the window's heartbeat asks for
 * a status every 20 seconds).
 *
 * A hold the status shows as begun after the first ask is a new drop's,
 * not this one's, and is left to its own episode. Returns whether the
 * release was confirmed. Every status read goes to `observe`, so the
 * screen hears of it at once. */
export async function releaseUntilLetGo(deps: {
  ask: () => Promise<void>;
  read: () => Promise<unknown>;
  observe: (raw: unknown) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<boolean> {
  const askedAt = deps.now();
  for (let attempt = 0; attempt <= RELEASE_RETRY_MS.length; attempt++) {
    if (attempt > 0) await deps.wait(RELEASE_RETRY_MS[attempt - 1]);
    try {
      await deps.ask();
    } catch {
      continue;
    }
    let raw: unknown;
    try {
      raw = await deps.read();
    } catch {
      continue;
    }
    deps.observe(raw);
    const hold = readHold(raw);
    if (hold?.state !== "holding") return true;
    // Whole seconds, rounded down: only a hold certainly younger than the
    // first ask is someone else's.
    if ((hold.heldSecs + 1) * 1_000 < deps.now() - askedAt) return true;
  }
  return false;
}

/** One release at a time: one asked while another is being confirmed
 * shares that one's answer rather than racing it. */
let releasing: Promise<boolean> | null = null;

export const holdService = {
  /** The teardown that keeps a hold: the service holds the gap if the
   * session was armed, and keeps a hold already in place. */
  disconnectKeepingHold(): Promise<void> {
    return withTimeout(invoke<void>("vpn_disconnect_for_reconnect"), "vpn_disconnect_for_reconnect");
  },
  /** Lets go, confirmed (`releaseUntilLetGo`). Never rejects. */
  release(): Promise<boolean> {
    releasing ??= releaseUntilLetGo({
      ask: () => withTimeout(invoke<void>("vpn_release_reconnect_hold"), "vpn_release_reconnect_hold"),
      read: async () => (await withTimeout(invoke<{ reconnectHold?: unknown }>("vpn_status"), "vpn_status")).reconnectHold,
      observe: (raw) => holdStore.observe(raw),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    })
      .catch(() => false)
      .finally(() => {
        releasing = null;
      });
    return releasing;
  },
  /** Tells the service a reconnect follows the drop it holds for: the
   * setting, said again. Never rejects; the episode's first dial says it
   * too. */
  keep(): Promise<void> {
    return withTimeout(invoke<void>("vpn_set_reconnect_hold", { enabled: true }), "vpn_set_reconnect_hold").catch(() => undefined);
  },
};
