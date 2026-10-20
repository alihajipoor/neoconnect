/** "Block the internet while reconnecting" (Windows, opt-in): the app's
 * half of the service's reconnect hold (service/src/engines/reconnect_hold.rs).
 *
 * The service does the blocking. It arms a session connected with the
 * setting on, starts holding the moment that session ends any way but the
 * customer's own Disconnect -- the engine dying, or the app's
 * `vpn_disconnect_for_reconnect` -- and lets go on Disconnect, on the app's
 * `vpn_release_reconnect_hold`, when the setting goes off, when the app
 * goes away, after 40 minutes with no tunnel, and before a connect it does
 * not cover (IKEv2, Custom mode). Nothing is held while it is off: the
 * default stays fail open.
 *
 * What the app owes it, decided here so it can be tested without a window:
 *
 *  - which teardown a pass uses (`passTeardown`): an automatic pass -- a
 *    reconnect's attempt, the mid-session failover -- and a press made
 *    while the hold is holding keep it through their teardowns; a press
 *    from a quiet screen lets go, as Disconnect always has;
 *  - when to let go (`shouldRelease`): a pass that landed a tunnel, an
 *    episode that ended without one, and a hold the service still reports
 *    over a tunnel that is up or with nothing left to reconnect it;
 *  - what the screen says about it (`holdNote`), from the service's own
 *    facts -- never from the setting alone. */

import { invoke } from "@tauri-apps/api/core";
import type { ReconnectPhase, ReconnectStop } from "./auto-reconnect";
import { withTimeout } from "./service-call";

export type ReconnectHoldProblem = "filtersRefused" | "tunnelNotPermitted" | "timedOut" | "notCovered" | "other";

/** The service's facts: `Response::State.reconnect_hold`. */
export type ReconnectHold =
  | { readonly state: "armed" }
  | { readonly state: "holding"; readonly heldSecs: number }
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
      return { state: "holding", heldSecs: typeof secs === "number" && Number.isFinite(secs) && secs >= 0 ? secs : 0 };
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

/** Whether an episode's end lets go of the hold: every end but a press of
 * the customer's own, whose pass decides (`passTeardown`) -- a Disconnect
 * lets go by itself, and Connect keeps it until it lands or fails. */
export function episodeEndReleases(before: ReconnectPhase, after: ReconnectPhase): boolean {
  const wasRunning = before.kind === "waiting" || before.kind === "attempting";
  if (!wasRunning) return false;
  if (after.kind === "armed") return true;
  if (after.kind !== "idle") return false;
  return !PRESSES.has(after.stopped ?? "customer");
}

const PRESSES: ReadonlySet<ReconnectStop> = new Set(["customer"]);

export type HoldNoteKey =
  | "hold.holding"
  | "hold.filtersRefused"
  | "hold.tunnelNotPermitted"
  | "hold.timedOut"
  | "hold.notCovered"
  | "hold.other";

/** What the main page says about the hold while a reconnect runs or the
 * connection has been lost: holding, or why not. Nothing outside those --
 * the hold is about the gap -- and nothing when the setting is off. */
export function holdNote(hold: ReconnectHold | null, { inGap, setting }: { inGap: boolean; setting: boolean }): HoldNoteKey | null {
  if (!setting || !inGap || hold === null) return null;
  if (hold.state === "holding") return "hold.holding";
  if (hold.state === "notHeld") return `hold.${hold.problem}`;
  return null;
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
 *  - an episode that landed, or ended any way but a press, lets go at once
 *    (`episodeEndReleases`) -- the gap is over, or nothing will close it;
 *  - one a press ended is the press's: its pass keeps the hold until it
 *    lands or fails. If no pass is running `PRESS_GRACE_MS` later -- a
 *    location picked and then nothing dialled -- it lets go then.
 *
 * Only while the setting is on: with it off the service holds nothing,
 * and nothing is asked. Returns the stop. */
export function watchEpisodesForHold(deps: {
  phase: () => ReconnectPhase;
  subscribe: (listener: () => void) => () => void;
  setting: () => boolean;
  passRunning: () => boolean;
  release: () => Promise<void>;
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
    if (running(prev) && after.kind === "idle") {
      later(() => {
        if (!deps.setting() || deps.passRunning() || running(deps.phase())) return;
        void deps.release();
      }, PRESS_GRACE_MS);
    }
  });
}

export const holdService = {
  /** The teardown that keeps a hold: the service holds the gap if the
   * session was armed, and keeps a hold already in place. */
  disconnectKeepingHold(): Promise<void> {
    return withTimeout(invoke<void>("vpn_disconnect_for_reconnect"), "vpn_disconnect_for_reconnect");
  },
  /** Lets go, at once. Fire and forget: a service that cannot be reached
   * lets go by itself when this app goes silent. */
  release(): Promise<void> {
    return withTimeout(invoke<void>("vpn_release_reconnect_hold"), "vpn_release_reconnect_hold").catch(() => undefined);
  },
};
