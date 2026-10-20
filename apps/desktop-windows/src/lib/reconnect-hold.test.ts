import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    calls.push(cmd);
    return Promise.resolve(cmd === "vpn_status" ? { connected: false } : undefined);
  },
}));

import { AutoReconnect, QUICK_DEATHS_TO_STOP, type Episode, type ReconnectPhase } from "./auto-reconnect";
import {
  episodeEndReleases,
  holdHint,
  holdNote,
  holdService,
  holdStore,
  holdWanted,
  passTeardown,
  PRESS_GRACE_MS,
  readHold,
  RECONNECT_HOLD_OFFERED,
  RECONNECT_HOLD_PROVEN,
  RELEASE_RETRY_MS,
  releaseUntilLetGo,
  shouldRelease,
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

beforeEach(() => {
  calls.length = 0;
  holdStore.resetForTests();
});

describe("the service's word on the hold", () => {
  it("is read as the service sends it", () => {
    expect(readHold({ state: "armed" })).toEqual({ state: "armed" });
    expect(readHold({ state: "holding", held_secs: 12 })).toEqual({ state: "holding", heldSecs: 12 });
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

describe("when a status says to let go", () => {
  it("over a tunnel that is up, with no pass keeping it", () => {
    expect(shouldRelease({ hold: HOLDING, tunnelUp: true, passRunning: false })).toBe(true);
  });

  it("never while a pass runs: it keeps the hold through its rungs and lets go when it lands", () => {
    expect(shouldRelease({ hold: HOLDING, tunnelUp: true, passRunning: true })).toBe(false);
  });

  it("never with no tunnel: that is the gap itself, and the episode's to end", () => {
    expect(shouldRelease({ hold: HOLDING, tunnelUp: false, passRunning: false })).toBe(false);
  });

  it("never for a hold that is not holding", () => {
    expect(shouldRelease({ hold: { state: "armed" }, tunnelUp: true, passRunning: false })).toBe(false);
    expect(shouldRelease({ hold: null, tunnelUp: true, passRunning: false })).toBe(false);
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

  it("leaves the headline's own hint when the service does not hold, or the setting is off", () => {
    expect(holdHint({ state: "armed" }, { reconnecting: false, dropped: true, setting: true })).toBeNull();
    expect(holdHint(null, { reconnecting: true, dropped: false, setting: true })).toBeNull();
    expect(holdHint(HOLDING, { reconnecting: false, dropped: true, setting: false })).toBeNull();
    expect(holdHint(HOLDING, { reconnecting: false, dropped: false, setting: true })).toBeNull();
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
  });
});

describe("the service calls", () => {
  it("are the ones the service answers", async () => {
    await holdService.disconnectKeepingHold();
    await holdService.release();
    await holdService.keep();
    expect(calls).toEqual(["vpn_disconnect_for_reconnect", "vpn_release_reconnect_hold", "vpn_status", "vpn_set_reconnect_hold"]);
  });
});
