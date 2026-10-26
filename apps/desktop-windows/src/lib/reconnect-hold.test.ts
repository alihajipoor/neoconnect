import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
/** What the mocked service answers a status with. */
let statusAnswer: unknown = { connected: false };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    calls.push(cmd);
    return Promise.resolve(cmd === "vpn_status" ? statusAnswer : undefined);
  },
}));

import { AutoReconnect, QUICK_DEATHS_TO_STOP, type Episode, type ReconnectPhase } from "./auto-reconnect";
import { notifyStep } from "./connection-notify";
import { DICTIONARIES } from "./i18n";
import {
  createStatusRelease,
  episodeEndReleases,
  gapTraffic,
  HOLD_HINTS,
  gapWord,
  hintKey,
  holdCovers,
  holdSpoken,
  switchBody,
  type GapWord,
  type HoldScene,
  holdHint,
  holdNote,
  holdNotes,
  HOLD_WORD_GRACE_MS,
  holdWordLate,
  holdService,
  holdStore,
  holdWanted,
  passTeardown,
  PRESS_GRACE_MS,
  readHold,
  RECONNECT_HOLD_OFFERED,
  RECONNECT_HOLD_PROVEN,
  RELEASE_RETRY_MS,
  RELEASE_READS_APART_MS,
  landedUnderHold,
  releaseUntilLetGo,
  watchEpisodesForHold,
  type ReconnectHold,
} from "./reconnect-hold";

const EPISODE = { session: 1 } as unknown as Episode;
const IDLE: ReconnectPhase = { kind: "idle", lost: false, stopped: null, session: null };
const ARMED: ReconnectPhase = { kind: "armed", since: 0, routeId: null, quickDeaths: 0, session: 1 };
const WAITING: ReconnectPhase = { kind: "waiting", attempt: 1, delayMs: 2_000, blockedBy: null, blockedSince: null, episode: EPISODE };
const ATTEMPTING: ReconnectPhase = { kind: "attempting", attempt: 1, startedAt: 0, episode: EPISODE };
const stoppedBy = (why: NonNullable<Extract<ReconnectPhase, { kind: "idle" }>["stopped"]>, lost = true): ReconnectPhase => ({
  kind: "idle",
  lost,
  stopped: why,
  session: 1,
});
const HOLDING: ReconnectHold = { state: "holding", heldSecs: 4 };
type ShownToneForTest = "idle" | "ok" | "hl" | "caution" | "warn" | "danger" | "muted";

beforeEach(() => {
  calls.length = 0;
  statusAnswer = { connected: false };
  holdStore.resetForTests();
});

describe("the service's word on the hold", () => {
  it("is read as the service sends it", () => {
    expect(readHold({ state: "armed" })).toEqual({ state: "armed" });
    expect(readHold({ state: "holding", held_secs: 12 })).toEqual({ state: "holding", heldSecs: 12 });
    expect(readHold({ state: "holding", held_secs: 12, landed: true })).toEqual({ state: "holding", heldSecs: 12, landed: true });
    expect(readHold({ state: "holding", held_secs: 12, landed: "yes" })).toEqual({ state: "holding", heldSecs: 12 });
    expect(readHold({ state: "notHeld", problem: "filtersRefused", detail: "0x80320009" })).toEqual({
      state: "notHeld",
      problem: "filtersRefused",
    });
  });

  it("says nothing for nothing, or for a shape it does not know", () => {
    expect(readHold(undefined)).toBeNull();
    expect(readHold(null)).toBeNull();
    expect(readHold("holding")).toBeNull();
    expect(readHold({ state: "blocking" })).toBeNull();
  });

  it("reads that port 53 is open to anywhere when the service says so", () => {
    expect(readHold({ state: "holding", held_secs: 3, dns_anywhere: true })).toEqual({ state: "holding", heldSecs: 3, dnsAnywhere: true });
    expect(readHold({ state: "holding", held_secs: 3, dns_anywhere: "yes" })).toEqual({ state: "holding", heldSecs: 3 });
    const heard = vi.fn();
    holdStore.subscribe(heard);
    holdStore.observe({ state: "holding", held_secs: 1 });
    holdStore.observe({ state: "holding", held_secs: 2, dns_anywhere: true });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("reads a reason from a newer service as other, and nonsense seconds as none", () => {
    expect(readHold({ state: "notHeld", problem: "somethingNew" })).toEqual({ state: "notHeld", problem: "other" });
    expect(readHold({ state: "holding", held_secs: -3 })).toEqual({ state: "holding", heldSecs: 0 });
  });

  it("is told to screens only when its state or reason changes, not every second it holds", () => {
    const heard = vi.fn();
    holdStore.subscribe(heard);
    holdStore.observe({ state: "holding", held_secs: 1 });
    holdStore.observe({ state: "holding", held_secs: 2 });
    holdStore.observe({ state: "notHeld", problem: "timedOut" });
    holdStore.observe({ state: "notHeld", problem: "timedOut" });
    holdStore.observe(undefined);
    expect(heard).toHaveBeenCalledTimes(3);
    expect(holdStore.current()).toBeNull();
  });
});

describe("which teardown a pass uses", () => {
  it("keeps the hold through an automatic pass with the setting on", () => {
    expect(passTeardown({ setting: true, automatic: true, holding: false })).toBe("keepHold");
  });

  it("keeps it through a press made while it holds -- Reconnect now", () => {
    expect(passTeardown({ setting: true, automatic: false, holding: true })).toBe("keepHold");
  });

  it("lets go for a press from a quiet screen, as Disconnect always has", () => {
    expect(passTeardown({ setting: true, automatic: false, holding: false })).toBe("plain");
  });

  it("never keeps anything with the setting off: the product fails open", () => {
    expect(passTeardown({ setting: false, automatic: true, holding: true })).toBe("plain");
  });
});

describe("a tunnel landed under the hold", () => {
  const LANDED: ReconnectHold = { state: "holding", heldSecs: 9, landed: true };

  it("is the service's word, with the engine up and the tunnel holding the machine itself", () => {
    expect(landedUnderHold(LANDED, { connected: true, ipv4Confined: true })).toBe(true);
    // WireGuard: no confinement of ours, and a fresh handshake.
    expect(landedUnderHold(LANDED, { connected: true, ipv4Confined: null, health: { state: "alive" } })).toBe(true);
    expect(landedUnderHold(LANDED, { connected: true, health: { state: "alive" } })).toBe(true);
  });

  it("is never connected beside a hold alone, a confinement not in, or a handshake not fresh", () => {
    // The service did not say it landed: the dropped session still in the
    // slot, or a service that predates the word.
    expect(landedUnderHold(HOLDING, { connected: true, ipv4Confined: true })).toBe(false);
    expect(landedUnderHold(LANDED, { connected: false, ipv4Confined: true })).toBe(false);
    expect(landedUnderHold(LANDED, { connected: true, ipv4Confined: false })).toBe(false);
    expect(landedUnderHold(LANDED, { connected: true, ipv4Confined: null, health: { state: "stale" } })).toBe(false);
    expect(landedUnderHold(LANDED, { connected: true, ipv4Confined: null, health: { state: "unknown" } })).toBe(false);
    expect(landedUnderHold({ state: "armed" }, { connected: true, ipv4Confined: true })).toBe(false);
    expect(landedUnderHold(null, { connected: true, ipv4Confined: true })).toBe(false);
  });
});

describe("letting go on status reads alone", () => {
  type Read = { connected: boolean; ipv4Confined: boolean | null; health: { state: string } };
  const CONFINED: Read = { connected: true, ipv4Confined: true, health: { state: "unknown" } };
  const CONTRADICTORY: Read = { connected: true, ipv4Confined: false, health: { state: "unknown" } };
  const DOWN: Read = { connected: false, ipv4Confined: null, health: { state: "down" } };

  it("follows a drop and a reconnect as the VM saw them, and lets go only on a landed tunnel read twice, a second apart", () => {
    const release = createStatusRelease();
    const see = (raw: unknown, status: Read, now: number, passRunning = false) =>
      release.see({ hold: readHold(raw), status, passRunning, now });
    // Connected and armed: nothing held.
    expect(see({ state: "armed" }, CONFINED, 0)).toBe(false);
    // 0.5 s after the drop, run rel-ikev2c: one read said connected, holding
    // and not confined at once -- the dead session not yet taken down. The
    // app let go on it, and the whole 26 s reconnect ran fail-open.
    expect(see({ state: "holding", held_secs: 0 }, CONTRADICTORY, 500)).toBe(false);
    expect(see({ state: "holding", held_secs: 1 }, CONTRADICTORY, 1_600)).toBe(false);
    // The gap itself: no tunnel.
    expect(see({ state: "holding", held_secs: 3 }, DOWN, 3_500)).toBe(false);
    // A pass dials and lands: while it runs, its rungs are its own.
    expect(see({ state: "holding", held_secs: 20, landed: true }, CONFINED, 20_000, true)).toBe(false);
    expect(see({ state: "holding", held_secs: 21, landed: true }, CONFINED, 21_500, true)).toBe(false);
    // The pass over and its own release lost: one landed read is not
    // enough, nor a second within the second...
    expect(see({ state: "holding", held_secs: 26, landed: true }, CONFINED, 26_000)).toBe(false);
    expect(see({ state: "holding", held_secs: 26, landed: true }, CONFINED, 26_000 + RELEASE_READS_APART_MS - 1)).toBe(false);
    // ...a second one a second after the first is.
    expect(see({ state: "holding", held_secs: 27, landed: true }, CONFINED, 26_000 + RELEASE_READS_APART_MS)).toBe(true);
  });

  it("starts over after any read between that does not show a landed tunnel", () => {
    const release = createStatusRelease();
    const LANDED: ReconnectHold = { state: "holding", heldSecs: 30, landed: true };
    expect(release.see({ hold: LANDED, status: CONFINED, passRunning: false, now: 0 })).toBe(false);
    expect(release.see({ hold: HOLDING, status: CONTRADICTORY, passRunning: false, now: 600 })).toBe(false);
    expect(release.see({ hold: LANDED, status: CONFINED, passRunning: false, now: 1_200 })).toBe(false);
    expect(release.see({ hold: LANDED, status: CONFINED, passRunning: true, now: 1_900 })).toBe(false);
    expect(release.see({ hold: LANDED, status: CONFINED, passRunning: false, now: 2_500 })).toBe(false);
    expect(release.see({ hold: LANDED, status: CONFINED, passRunning: false, now: 3_500 })).toBe(true);
  });

  it("never lets go from the statuses of a service that does not say a tunnel landed", () => {
    const release = createStatusRelease();
    for (let now = 0; now < 10_000; now += 500) {
      expect(release.see({ hold: HOLDING, status: CONFINED, passRunning: false, now })).toBe(false);
    }
  });
});

describe("where other traffic goes in the gap", () => {
  it("is the service's word, and neither until it has said", () => {
    expect(gapTraffic(HOLDING, true)).toBe("blocked");
    expect(gapTraffic({ state: "armed" }, true)).toBe("unconfirmed");
    expect(gapTraffic({ state: "notHeld", problem: "timedOut" }, true)).toBe("open");
    expect(gapTraffic(null, true)).toBe("open");
    // The setting off: nothing is held, whatever a stale word says.
    expect(gapTraffic(HOLDING, false)).toBe("open");
    expect(gapTraffic({ state: "armed" }, false)).toBe("open");
  });
});

describe("an episode's end", () => {
  it("lets go when it landed", () => {
    expect(episodeEndReleases(ATTEMPTING, ARMED)).toBe(true);
  });

  it("lets go when it gave up or was stopped, whatever the reason but a press", () => {
    for (const why of ["stopped", "attempts", "budget", "quickDeaths", "refused", "notEntitled", "waitedTooLong", "excluded", "signedOut", "nothingToDial"] as const) {
      expect(episodeEndReleases(WAITING, stoppedBy(why)), why).toBe(true);
    }
  });

  it("leaves a press's own pass to decide", () => {
    expect(episodeEndReleases(WAITING, stoppedBy("customer", false))).toBe(false);
  });

  it("is not an end when nothing was dropped or running", () => {
    expect(episodeEndReleases(IDLE, ARMED)).toBe(false);
    expect(episodeEndReleases(IDLE, stoppedBy("quickDeaths"))).toBe(false);
    expect(episodeEndReleases(ARMED, ARMED)).toBe(false);
  });

  it("lets go when a drop began no episode at all: armed straight to idle, for anything but a press", () => {
    for (const why of ["quickDeaths", "refused", "notEntitled", "excluded", "signedOut"] as const) {
      expect(episodeEndReleases(ARMED, stoppedBy(why)), why).toBe(true);
    }
    expect(episodeEndReleases(ARMED, stoppedBy("customer", false))).toBe(false);
    expect(episodeEndReleases(ARMED, IDLE)).toBe(false);
  });
});

describe("watching episodes for the hold", () => {
  function harness(setting = true) {
    let phase: ReconnectPhase = ARMED;
    const listeners = new Set<() => void>();
    const released: number[] = [];
    const timers: (() => void)[] = [];
    let passRunning = false;
    const kept: number[] = [];
    const stop = watchEpisodesForHold({
      phase: () => phase,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      setting: () => setting,
      passRunning: () => passRunning,
      release: async () => {
        released.push(1);
      },
      keep: async () => {
        kept.push(1);
      },
      later: (fn, ms) => {
        expect(ms).toBe(PRESS_GRACE_MS);
        timers.push(fn);
      },
    });
    return {
      go(next: ReconnectPhase) {
        phase = next;
        for (const l of [...listeners]) l();
      },
      released,
      kept,
      fire: () => timers.splice(0).forEach((fn) => fn()),
      setPass: (on: boolean) => (passRunning = on),
      stop,
    };
  }

  it("lets go as the episode gives up", () => {
    const h = harness();
    h.go(WAITING);
    h.go(ATTEMPTING);
    expect(h.released).toHaveLength(0);
    h.go(stoppedBy("attempts"));
    expect(h.released).toHaveLength(1);
  });

  it("gives a press's pass a few seconds, and lets go if none started", () => {
    const h = harness();
    h.go(WAITING);
    h.go(stoppedBy("customer", false));
    expect(h.released).toHaveLength(0);
    h.fire();
    expect(h.released).toHaveLength(1);
  });

  it("leaves the hold to a press's pass that is running", () => {
    const h = harness();
    h.go(WAITING);
    h.go(stoppedBy("customer", false));
    h.setPass(true);
    h.fire();
    expect(h.released).toHaveLength(0);
  });

  it("asks nothing of the service with the setting off", () => {
    const h = harness(false);
    h.go(WAITING);
    h.go(stoppedBy("attempts"));
    h.fire();
    expect(h.released).toHaveLength(0);
    expect(h.kept).toHaveLength(0);
  });

  it("tells the service a reconnect follows as an episode begins, once", () => {
    const h = harness();
    h.go(WAITING);
    h.go(ATTEMPTING);
    h.go(WAITING);
    expect(h.kept).toHaveLength(1);
    expect(h.released).toHaveLength(0);
  });

  it("gives a press over an armed tunnel the same few seconds", () => {
    const h = harness();
    h.go(stoppedBy("customer", false));
    expect(h.released).toHaveLength(0);
    h.fire();
    expect(h.released).toHaveLength(1);
  });
});

describe("a drop the real reconnect does not take up", () => {
  /** The real controller, nothing bound to run its attempts, and the
   * watch over it: the path Dashboard's publishDrop takes. */
  function real() {
    let now = 1_000_000;
    const rc = new AutoReconnect({
      now: () => now,
      elapsed: () => now,
      setTimer: () => 0,
      clearTimer: () => undefined,
      online: () => true,
      foreground: () => true,
      session: () => 1,
      report: () => undefined,
      slotIdle: () => undefined,
    });
    const released: number[] = [];
    watchEpisodesForHold({
      phase: rc.current,
      subscribe: rc.subscribe,
      setting: () => true,
      passRunning: () => false,
      release: async () => {
        released.push(1);
      },
      keep: async () => undefined,
      later: () => undefined,
    });
    return { rc, released, tick: (ms: number) => (now += ms) };
  }

  it("lets go on the third quick death, which goes from armed straight to idle", () => {
    const { rc, released, tick } = real();
    rc.tunnelUp({ routeId: "r1", fresh: true, stamp: rc.stamp() });
    for (let death = 1; death < QUICK_DEATHS_TO_STOP; death++) {
      tick(1_000);
      expect(rc.dropped()).toBe("reconnecting");
      rc.tunnelUp({ routeId: "r1", fresh: true, stamp: rc.stamp() });
    }
    const before = released.length;
    tick(1_000);
    expect(rc.dropped()).toBe("lost");
    expect(rc.current()).toMatchObject({ kind: "idle", stopped: "quickDeaths" });
    expect(released.length).toBe(before + 1);
  });

  it("lets go when the plan has stopped, or anything else rules the reconnect out", () => {
    for (const exclusion of ["notEntitled", "refused", "excluded"] as const) {
      const { rc, released } = real();
      rc.tunnelUp({ routeId: "r1", fresh: true, stamp: rc.stamp() });
      expect(rc.dropped({ exclusion })).toBe("lost");
      expect(released, exclusion).toHaveLength(1);
    }
  });
});

describe("whether this build offers it", () => {
  it("does not until a capture has proved it: a release build carries no switch", () => {
    // Tests run as a release is built: no VITE_RECONNECT_HOLD.
    expect(RECONNECT_HOLD_PROVEN).toBe(false);
    expect(RECONNECT_HOLD_OFFERED).toBe(false);
    expect(holdWanted(true)).toBe(false);
    expect(holdWanted(false)).toBe(false);
  });
});

describe("letting go, confirmed", () => {
  function service(answers: unknown[], { askFails = 0 }: { askFails?: number } = {}) {
    let clock = 0;
    let asks = 0;
    let reads = 0;
    const waits: number[] = [];
    const observed: unknown[] = [];
    const run = releaseUntilLetGo({
      ask: async () => {
        asks += 1;
        if (asks <= askFails) throw new Error("did not answer in time");
      },
      read: async () => answers[Math.min(reads++, answers.length - 1)],
      observe: (raw) => observed.push(raw),
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    return { run, asks: () => asks, waits, observed };
  }

  it("is done once a status says it no longer holds", async () => {
    const s = service([undefined]);
    expect(await s.run).toBe(true);
    expect(s.asks()).toBe(1);
    expect(s.observed).toEqual([undefined]);
  });

  it("asks again while the hold is still there, then gives up", async () => {
    const s = service([{ state: "holding", held_secs: 30 }]);
    expect(await s.run).toBe(false);
    expect(s.asks()).toBe(RELEASE_RETRY_MS.length + 1);
    expect(s.waits).toEqual([...RELEASE_RETRY_MS]);
  });

  it("gets there after a call that timed out", async () => {
    const s = service([{ state: "holding", held_secs: 30 }, undefined], { askFails: 1 });
    expect(await s.run).toBe(true);
    expect(s.asks()).toBe(3);
  });

  it("leaves a hold that began after it asked to that drop's own episode", async () => {
    // Asked at 0, and still the old hold, thirty seconds old. Then a hold
    // under a second old: at 0.5 s it could still be the one asked about,
    // and is asked again; at 1.5 s it cannot be, and is left alone.
    const s = service([{ state: "holding", held_secs: 30 }, { state: "holding", held_secs: 0 }]);
    expect(await s.run).toBe(true);
    expect(s.asks()).toBe(3);
  });

  it("goes through the service's own calls, and shares one confirmation between two asks", async () => {
    const [a, b] = await Promise.all([holdService.release(), holdService.release()]);
    expect([a, b]).toEqual([true, true]);
    expect(calls).toEqual(["vpn_release_reconnect_hold", "vpn_status"]);
  });
});

describe("the sentence under the state", () => {
  it("says it holds while a reconnect runs, and that it is still blocked after a drop nothing reconnects", () => {
    expect(holdHint(HOLDING, { reconnecting: true, dropped: false, setting: true })).toBe("hold.holding");
    expect(holdHint(HOLDING, { reconnecting: false, dropped: true, setting: true })).toBe("hold.heldAfterDrop");
  });

  it("says neither in the gap before the service has said whether the hold is in", () => {
    // Its last word "armed": on the VM the screen said "going out without
    // Neoxify" for 0.25 to 0.5 s at every reconnect's start, and 2.3 s after
    // a network cut, while the service already held.
    expect(holdHint({ state: "armed" }, { reconnecting: true, dropped: false, setting: true })).toBe("hold.unconfirmed");
    expect(holdHint({ state: "armed" }, { reconnecting: false, dropped: true, setting: true })).toBe("hold.unconfirmed");
    expect(holdHint({ state: "armed" }, { reconnecting: false, dropped: false, setting: true })).toBeNull();
    expect(HOLD_HINTS).toEqual(["hold.holding", "hold.heldAfterDrop", "hold.unconfirmed", "hold.unanswered"]);
  });

  it("leaves the headline's own hint when the service says nothing is held, or the setting is off", () => {
    expect(holdHint(null, { reconnecting: true, dropped: false, setting: true })).toBeNull();
    expect(holdHint({ state: "notHeld", problem: "filtersRefused" }, { reconnecting: true, dropped: false, setting: true })).toBeNull();
    expect(holdHint({ state: "armed" }, { reconnecting: true, dropped: false, setting: false })).toBeNull();
    expect(holdHint(HOLDING, { reconnecting: false, dropped: true, setting: false })).toBeNull();
    expect(holdHint(HOLDING, { reconnecting: false, dropped: false, setting: true })).toBeNull();
  });
});

// WireGuard's block could not stand while connected (2026-10-20 review):
// held from the report of the drop, after wireguard.exe's own filters had
// gone -- the measured 0.2 to 0.6 s. The service says so; nothing on screen
// or in a toast may say the drop was blocked from its first moment.
describe("a hold that went in late", () => {
  const LATE: ReconnectHold = { state: "holding", heldSecs: 2, standingRefused: true };

  it("is read from the service's word, and only from a true", () => {
    expect(readHold({ state: "holding", held_secs: 2, standing_refused: true })).toEqual(LATE);
    expect(readHold({ state: "holding", held_secs: 2, standing_refused: "yes" })).toEqual({ state: "holding", heldSecs: 2 });
    expect(readHold({ state: "holding", held_secs: 2 })).toEqual({ state: "holding", heldSecs: 2 });
  });

  it("blocks now, and says the moment before was not", () => {
    expect(gapTraffic(LATE, true)).toBe("blockedLate");
    expect(gapTraffic(LATE, false)).toBe("open");
    expect(holdHint(LATE, { reconnecting: true, dropped: false, setting: true })).toBe("hold.holding");
    expect(holdHint(LATE, { reconnecting: false, dropped: true, setting: true })).toBe("hold.heldAfterDrop");
    expect(holdNotes(LATE, { inGap: true, setting: true })).toEqual(["hold.holding", "hold.heldLate"]);
    expect(holdNotes({ ...LATE, dnsAnywhere: true }, { inGap: true, setting: true })).toEqual(["hold.dnsAnywhere", "hold.heldLate"]);
    expect(holdNotes(LATE, { inGap: false, setting: true })).toEqual([]);
    expect(holdNotes(LATE, { inGap: true, setting: false })).toEqual([]);
    expect(holdNotes(HOLDING, { inGap: true, setting: true })).toEqual(["hold.holding"]);
  });

  it("is news to a screen that heard the hold before", () => {
    holdStore.resetForTests();
    let heard = 0;
    holdStore.subscribe(() => {
      heard += 1;
    });
    holdStore.observe({ state: "holding", held_secs: 1 });
    holdStore.observe({ state: "holding", held_secs: 2, standing_refused: true });
    expect(heard).toBe(2);
    expect(holdStore.current()).toEqual(LATE);
    holdStore.resetForTests();
  });
});

// Calm UI (2026-10-20 review): with the setting on, every gap showed
// "checking whether other connections are blocked" and then "blocked" as
// soon as the service answered, usually within half a second -- the hint
// changing twice in the first second of every short reconnect. Now nothing
// is said until the word has been awaited HOLD_WORD_GRACE_MS: the room stays
// empty, then the answer, said once.
describe("the service's word, given its grace", () => {
  /** Plays a gap from its first moment: the service's word on the hold at
   * each time (ms), and what the hint and a "lost" notification would say
   * at every 100 ms -- as the main page reads them, with one clock. */
  function playGap(words: [number, ReconnectHold | null][], until: number) {
    const holdAt = (t: number) => [...words].reverse().find(([at]) => at <= t)?.[1] ?? null;
    const hints: (string | null)[] = [];
    const toasts: (string | null)[] = [];
    let awaitedSince: number | null = null;
    for (let t = 0; t <= until; t += 100) {
      const hold = holdAt(t);
      const gap = gapTraffic(hold, true);
      awaitedSince = gap === "unconfirmed" ? (awaitedSince ?? t) : null;
      const late = holdWordLate(awaitedSince, t);
      hints.push(holdHint(hold, { reconnecting: true, dropped: false, setting: true, wordLate: late }));
      toasts.push(notifyStep(FRESH_MEMORY_UP, { tone: "warn", reconnecting: true, gap: gapWord(gap, late), focused: false, gaming: false }).say);
    }
    return { hints, toasts };
  }
  const FRESH_MEMORY_UP = { up: true, lostSaid: false };
  const changes = (said: (string | null)[]) => said.filter((x, i) => i === 0 || x !== said[i - 1]);

  it("says the hold once when the service answers within the grace", () => {
    const { hints, toasts } = playGap([[0, { state: "armed" }], [400, HOLDING]], 3_000);
    expect(changes(hints)).toEqual(["pending", "hold.holding"]);
    expect(hints).not.toContain("hold.unconfirmed");
    expect(changes(toasts)).toEqual([null, "lostHeld"]);
  });

  it("says it is checking only once the word is late, then the word", () => {
    const { hints, toasts } = playGap([[0, { state: "armed" }], [2_000, HOLDING]], 3_000);
    expect(changes(hints)).toEqual(["pending", "hold.unconfirmed", "hold.holding"]);
    expect(hints.indexOf("hold.unconfirmed") * 100).toBe(HOLD_WORD_GRACE_MS);
    expect(changes(toasts)).toEqual([null, "lostUnconfirmed", "lostHeld"]);
  });

  it("needs no grace for a word already in, or one that says nothing is held", () => {
    expect(changes(playGap([[0, HOLDING]], 1_000).hints)).toEqual(["hold.holding"]);
    expect(changes(playGap([[0, { state: "notHeld", problem: "timedOut" }]], 1_000).hints)).toEqual([null]);
    expect(holdWordLate(null, 10_000)).toBe(false);
    expect(holdWordLate(0, HOLD_WORD_GRACE_MS - 1)).toBe(false);
    expect(holdWordLate(0, HOLD_WORD_GRACE_MS)).toBe(true);
    expect(gapWord("unconfirmed", false)).toBe("pending");
    expect(gapWord("unconfirmed", true)).toBe("unconfirmed");
    expect(gapWord("blocked", false)).toBe("blocked");
  });
});

describe("what the main page says about it", () => {
  it("says it holds, or why not, only in the gap and only with the setting on", () => {
    expect(holdNote(HOLDING, { inGap: true, setting: true })).toBe("hold.holding");
    expect(holdNote({ state: "notHeld", problem: "filtersRefused" }, { inGap: true, setting: true })).toBe("hold.filtersRefused");
    expect(holdNote({ state: "notHeld", problem: "other" }, { inGap: true, setting: true })).toBe("hold.other");
    expect(holdNote(HOLDING, { inGap: false, setting: true })).toBeNull();
    expect(holdNote(HOLDING, { inGap: true, setting: false })).toBeNull();
    expect(holdNote({ state: "armed" }, { inGap: true, setting: true })).toBeNull();
    // Port 53 open to anywhere is said, beside the hint that it holds.
    expect(holdNote({ state: "holding", heldSecs: 1, dnsAnywhere: true }, { inGap: true, setting: true })).toBe("hold.dnsAnywhere");
    expect(holdHint({ state: "holding", heldSecs: 1, dnsAnywhere: true }, { reconnecting: true, dropped: false, setting: true })).toBe(
      "hold.holding",
    );
  });
});

describe("the service calls", () => {
  it("are the ones the service answers", async () => {
    await holdService.disconnectKeepingHold();
    await holdService.release();
    await holdService.keep();
    expect(calls).toEqual([
      "vpn_disconnect_for_reconnect",
      "vpn_status",
      "vpn_release_reconnect_hold",
      "vpn_status",
      "vpn_set_reconnect_hold",
    ]);
  });

  // The VM, round 2: the failover's teardown put the hold in, and the screen
  // heard of it only at the next poll, up to two seconds on.
  it("asks for the hold's word as soon as the teardown that keeps it is answered", async () => {
    statusAnswer = { connected: false, reconnectHold: { state: "holding", held_secs: 0 } };
    await holdService.disconnectKeepingHold();
    expect(calls).toEqual(["vpn_disconnect_for_reconnect", "vpn_status"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(holdStore.current()).toEqual({ state: "holding", heldSecs: 0 });
  });

  it("drops that word when something newer has been heard meanwhile", () => {
    holdStore.observe({ state: "holding", held_secs: 2 });
    const mark = holdStore.mark();
    holdStore.released();
    holdStore.observeSince(mark, { state: "holding", held_secs: 2 });
    expect(holdStore.current()).toBeNull();
    const again = holdStore.mark();
    holdStore.observeSince(again, { state: "armed" });
    expect(holdStore.current()).toEqual({ state: "armed" });
  });
});

// The VM, 2026-10-20 (round 2): the mid-session failover held for 25 to 84 s
// under "Checking connection..." alone, with no "lost" toast in held words;
// the degraded "...Your traffic is NOT protected" line stayed 0.4 to 1.0 s
// into the hold; and between two failed attempts "Couldn't connect." stood
// 1.3 to 6.3 s over a machine the service still held. The service's word now
// decides the held words in every phase but a quiet screen.
describe("the held words in every phase", () => {
  const LANDED: ReconnectHold = { state: "holding", heldSecs: 2, landed: true };
  const at = (scene: Partial<HoldScene>, hold: ReconnectHold | null, wordLate = true) =>
    holdHint(hold, { reconnecting: false, dropped: false, ...scene, setting: true, wordLate });
  /** What goes under the state, as the main page picks it. */
  const under = (scene: Partial<HoldScene>, hold: ReconnectHold | null, error: string | null, wordLate = true) =>
    hintKey(at(scene, hold, wordLate), { teardownShowing: false, error, headline: "headline" });

  it("says it holds through the failover's ladder, over a tunnel still shown up, and between attempts", () => {
    expect(at({ checking: true }, HOLDING)).toBe("hold.holding");
    expect(at({ tunnelUp: true }, HOLDING)).toBe("hold.holding");
    expect(at({ reconnecting: true }, HOLDING)).toBe("hold.holding");
    expect(at({ dropped: true }, HOLDING)).toBe("hold.heldAfterDrop");
    expect(holdSpoken(HOLDING, { reconnecting: false, dropped: false, checking: true })).toBe(true);
    expect(holdSpoken(HOLDING, { reconnecting: false, dropped: false, tunnelUp: true })).toBe(true);
  });

  it("leaves a tunnel that landed under the hold its own words, and a quiet screen its own", () => {
    expect(at({ tunnelUp: true }, LANDED)).toBeNull();
    expect(at({ tunnelUp: true, reconnecting: true }, LANDED)).toBeNull();
    expect(holdSpoken(LANDED, { reconnecting: false, dropped: false, tunnelUp: true })).toBe(false);
    expect(at({}, HOLDING)).toBeNull();
    expect(holdSpoken(HOLDING, { reconnecting: false, dropped: false })).toBe(false);
  });

  it("never leaves the degraded 'NOT protected' line over a machine it holds, landed or not", () => {
    // A rung that landed under the hold and is then shown degraded is still
    // held: its own line ("...Your traffic is NOT protected") would be false.
    expect(at({ tunnelUp: true, degraded: true }, LANDED)).toBe("hold.holding");
    expect(at({ tunnelUp: true, degraded: true }, HOLDING)).toBe("hold.holding");
    expect(holdSpoken(LANDED, { reconnecting: false, dropped: false, tunnelUp: true, degraded: true })).toBe(true);
    // Not held, it is the degraded line's to say.
    expect(at({ tunnelUp: true, degraded: true }, { state: "armed" })).toBeNull();
    expect(at({ tunnelUp: true, degraded: true }, null)).toBeNull();
  });

  it("claims nothing before the word in a pass or over a tunnel, whose own lines claim nothing either way", () => {
    expect(at({ checking: true }, { state: "armed" })).toBeNull();
    expect(at({ tunnelUp: true }, { state: "armed" })).toBeNull();
    expect(at({ reconnecting: true, tunnelUp: true }, { state: "armed" })).toBeNull();
    expect(at({ checking: true }, { state: "armed" }, false)).toBeNull();
    expect(holdSpoken({ state: "armed" }, { reconnecting: false, dropped: false, checking: true })).toBe(false);
  });

  it("puts the service's word over a connect's error, the error over the headline, and nothing over a teardown", () => {
    expect(under({ reconnecting: true }, HOLDING, "err.couldNotConnect")).toBe("hold.holding");
    expect(under({ reconnecting: true }, { state: "armed" }, "err.couldNotConnect")).toBe("hold.unconfirmed");
    expect(under({ reconnecting: true }, { state: "armed" }, "err.couldNotConnect", false)).toBe("err.couldNotConnect");
    expect(under({ reconnecting: true }, { state: "armed" }, null, false)).toBeNull();
    expect(under({ reconnecting: true }, null, "err.couldNotConnect")).toBe("err.couldNotConnect");
    expect(under({ reconnecting: true }, null, null)).toBe("headline");
    expect(hintKey("hold.holding", { teardownShowing: true, error: null, headline: "headline" })).toBeNull();
  });

  it("replays the VM's failover and a reconnect's failed attempts: held words from the hold's first word to its last", () => {
    // [the scene, the service's word, an error on screen], as the run went.
    const steps: [Partial<HoldScene>, ReconnectHold | null, string | null][] = [
      [{ tunnelUp: true }, { state: "armed" }, null], // degraded, before the failover
      [{ tunnelUp: true }, HOLDING, null], // the ladder's teardown held; the screen still degraded
      [{ checking: true }, HOLDING, null], // "Checking connection..."
      [{ checking: true }, HOLDING, null],
      [{ checking: true, tunnelUp: true }, LANDED, null], // a rung landed under the hold
      [{ tunnelUp: true }, null, null], // let go of: verified
      [{ reconnecting: true }, HOLDING, "err.couldNotConnect"], // between two failed attempts
      [{ reconnecting: true }, HOLDING, null],
    ];
    expect(steps.map(([scene, hold, error]) => under(scene, hold, error))).toEqual([
      "headline",
      "hold.holding",
      "hold.holding",
      "hold.holding",
      "headline",
      "headline",
      "hold.holding",
      "hold.holding",
    ]);
  });

  it("sends the failover's loss in held words once the service holds for it, then that it is back", () => {
    // The failover, as the main page plays it with the setting on: the
    // screen degraded (warn, verified before), the ladder's own look (warn,
    // as a reconnect's), the service's word arriving, the tunnel back.
    const looks: [ShownToneForTest, GapWord][] = [
      ["warn", "pending"],
      ["warn", "unconfirmed"],
      ["warn", "blocked"],
      ["warn", "blocked"],
      ["ok", "open"],
    ];
    let memory = { up: true, lostSaid: false };
    const said = looks.map(([tone, gap]) => {
      const step = notifyStep(memory, { tone, reconnecting: true, failover: true, gap, focused: false, gaming: false });
      memory = step.memory;
      return step.say;
    });
    expect(said).toEqual([null, null, "lostHeld", null, "back"]);
    // With nothing held -- the setting on, the hold refused -- it says
    // nothing new, as the failover never has.
    const open = notifyStep({ up: true, lostSaid: false }, { tone: "warn", reconnecting: true, failover: true, gap: "open", focused: false, gaming: false });
    expect(open.say).toBeNull();
    expect(open.memory).toEqual({ up: true, lostSaid: false });
  });
});

// The VM, round 2: after a service restart the screen said "blocked" for
// 2.5 s while the service could not be reached -- and the restart had taken
// the hold away. Unanswered, it is neither claimed nor denied.
describe("a service that does not answer", () => {
  it("is said to be being checked, at once, never blocked and never open", () => {
    holdStore.observe({ state: "holding", held_secs: 3 });
    holdStore.unanswered();
    const hold = holdStore.current();
    expect(hold).toEqual({ state: "unanswered" });
    expect(gapTraffic(hold, true)).toBe("unanswered");
    expect(gapTraffic(hold, false)).toBe("open");
    expect(gapWord("unanswered", false)).toBe("unanswered");
    expect(holdHint(hold, { reconnecting: true, dropped: false, setting: true, wordLate: false })).toBe("hold.unanswered");
    expect(holdHint(hold, { reconnecting: false, dropped: true, setting: true, wordLate: false })).toBe("hold.unanswered");
    expect(holdHint(hold, { reconnecting: false, dropped: false, checking: true, setting: true })).toBe("hold.unanswered");
    expect(holdHint(hold, { reconnecting: false, dropped: false, tunnelUp: true, setting: true })).toBeNull();
    expect(notifyStep({ up: true, lostSaid: false }, { tone: "warn", reconnecting: true, gap: "unanswered", focused: false, gaming: false }).say).toBe(
      "lostUnconfirmed",
    );
    expect(notifyStep({ up: true, lostSaid: true }, { tone: "danger", reconnecting: false, gap: "unanswered", focused: false, gaming: false }).say).toBeNull();
    // Answered again: its word, whatever it is.
    holdStore.observe(undefined);
    expect(holdStore.current()).toBeNull();
  });

  it("leaves nothing said as nothing", () => {
    holdStore.unanswered();
    expect(holdStore.current()).toBeNull();
  });
});

// The VM, round 2: after Disconnect or "Stop reconnecting" the held sentence
// outlived the release by 1.0 to 1.25 s, until the next status read.
describe("letting go, on the reply", () => {
  it("drops the held words when the service answers the release, before any status is read", async () => {
    holdStore.observe({ state: "holding", held_secs: 3 });
    let atRead: ReconnectHold | null | "unread" = "unread";
    await releaseUntilLetGo({
      ask: async () => undefined,
      read: async () => {
        atRead = holdStore.current();
        return undefined;
      },
      observe: (raw) => holdStore.observe(raw),
      released: () => holdStore.released(),
      wait: async () => undefined,
      now: () => 0,
    });
    expect(atRead).toBeNull();
  });

  it("leaves an armed session armed, and a hold no ask was answered for as it is", async () => {
    holdStore.observe({ state: "armed" });
    holdStore.released();
    expect(holdStore.current()).toEqual({ state: "armed" });
    holdStore.observe({ state: "holding", held_secs: 3 });
    await releaseUntilLetGo({
      ask: async () => {
        throw new Error("did not answer in time");
      },
      read: async () => ({ state: "holding", held_secs: 3 }),
      observe: (raw) => holdStore.observe(raw),
      released: () => holdStore.released(),
      wait: async () => undefined,
      now: () => 0,
    });
    expect(holdStore.current()?.state).toBe("holding");
  });
});

// The VM, round 2: the switch confirmation said "...your traffic is not
// protected" over a machine the service was blocking, before a switch to
// Built-in (IKEv2) -- which lets go of the block before it dials.
describe("the switch confirmation while it holds", () => {
  it("says IKEv2 and Custom mode let go of the block before they connect, and never 'not protected' over it", () => {
    expect(switchBody("blocked", { covered: false })).toBe("sw.bodyHeldNotCovered");
    expect(switchBody("blockedLate", { covered: false })).toBe("sw.bodyHeldNotCovered");
    expect(switchBody("blocked", { covered: true })).toBe("sw.bodyHeld");
    for (const gap of ["open", "unconfirmed", "unanswered"] as const) expect(switchBody(gap, { covered: false })).toBe("sw.body");
    expect(holdCovers("IKEV2", false)).toBe(false);
    expect(holdCovers("XRAY_VLESS_REALITY", true)).toBe(false);
    expect(holdCovers("WIREGUARD", false)).toBe(true);
    expect(holdCovers(null, false)).toBe(true);
  });

  it("in English and Persian, from one source", () => {
    for (const [language, notProtected, blocked] of [
      ["en", "not protected", "blocked"],
      ["fa", "محافظت نمی‌شود", "مسدود"],
    ] as const) {
      const words = DICTIONARIES[language];
      for (const key of ["sw.bodyHeld", "sw.bodyHeldNotCovered", "hold.unanswered"] as const) {
        expect(words[key], `${language} ${key}`).toBeTruthy();
        expect(words[key], `${language} ${key}`).not.toContain(notProtected);
      }
      expect(words["sw.bodyHeldNotCovered"]).toContain("IKEv2");
      expect(words["sw.bodyHeldNotCovered"]).toContain(blocked);
      expect(words["sw.body"]).toContain(notProtected);
    }
  });

  it("says, unanswered, that it is checking -- never that they are still blocked, nor that they are not", () => {
    expect(DICTIONARIES.en["hold.unanswered"]).toContain("checking");
    expect(DICTIONARIES.en["hold.unanswered"]).not.toMatch(/still|without Neoxify|not protected/);
    expect(DICTIONARIES.fa["hold.unanswered"]).toContain("در حال بررسی");
    expect(DICTIONARIES.fa["hold.unanswered"]).not.toMatch(/هنوز|بدون نئوکسیفای|محافظت نمی‌شود/);
  });
});
