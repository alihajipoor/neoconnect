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
 *  - when to let go (`shouldRelease`, `episodeEndReleases`): a pass that
 *    landed a tunnel, an episode that ended without one, a drop that began
 *    none, and a hold the service still reports over a tunnel that is up;
 *  - what the screen says about it (`holdNote`, `holdHint`), from the
 *    service's own facts -- never from the setting alone. */

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
  | { readonly state: "holding"; readonly heldSecs: number; readonly dnsAnywhere?: true }
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

/** Whether a status read says to let go of a hold: the service is holding
 * over a tunnel that is up, and no pass of ours is keeping it through its
 * rungs -- the gap it was for is over. Read off one status, never the
 * screen's state, which lags the service by up to a second around a drop:
 * holding with no tunnel is the gap itself, and is the episode's to end
 * (`episodeEndReleases`, `watchEpisodesForHold`). */
export function shouldRelease({
  hold,
  tunnelUp,
  passRunning,
}: {
  hold: ReconnectHold | null;
  /** The same status's `connected`. */
  tunnelUp: boolean;
  passRunning: boolean;
}): boolean {
  return hold?.state === "holding" && tunnelUp && !passRunning;
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
 * than what goes out. */
export function holdNote(hold: ReconnectHold | null, { inGap, setting }: { inGap: boolean; setting: boolean }): HoldNoteKey | null {
  if (!setting || !inGap || hold === null) return null;
  if (hold.state === "holding") return hold.dnsAnywhere === true ? "hold.dnsAnywhere" : "hold.holding";
  if (hold.state === "notHeld") return `hold.${hold.problem}`;
  return null;
}

/** The sentence under the state, when the hold is what it has to say.
 *
 * While a reconnect runs and the service holds: blocked until Neoxify
 * reconnects. After a drop that nothing is reconnecting, while the service
 * still says it holds -- between the drop and the release reaching it, or
 * a service that has not answered the release -- the internet is not
 * "going out without Neoxify", and saying so would be false: it is blocked
 * until the block is lifted. Null leaves the headline's own hint. Off the
 * service's own word, never the setting alone. */
export function holdHint(
  hold: ReconnectHold | null,
  { reconnecting, dropped, setting }: { reconnecting: boolean; dropped: boolean; setting: boolean },
): "hold.holding" | "hold.heldAfterDrop" | null {
  if (!setting || hold?.state !== "holding") return null;
  if (reconnecting) return "hold.holding";
  return dropped ? "hold.heldAfterDrop" : null;
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
  if (a.state === "holding" && b.state === "holding") return a.dnsAnywhere === b.dnsAnywhere;
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
