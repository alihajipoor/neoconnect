import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    calls.push(cmd);
    return Promise.resolve();
  },
}));

import type { Episode, ReconnectPhase } from "./auto-reconnect";
import {
  episodeEndReleases,
  holdNote,
  holdService,
  holdStore,
  passTeardown,
  PRESS_GRACE_MS,
  readHold,
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

  it("is not an end when no episode was running", () => {
    expect(episodeEndReleases(ARMED, IDLE)).toBe(false);
    expect(episodeEndReleases(IDLE, ARMED)).toBe(false);
  });
});

describe("watching episodes for the hold", () => {
  function harness(setting = true) {
    let phase: ReconnectPhase = ARMED;
    const listeners = new Set<() => void>();
    const released: number[] = [];
    const timers: (() => void)[] = [];
    let passRunning = false;
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
    expect(calls).toEqual(["vpn_disconnect_for_reconnect", "vpn_release_reconnect_hold"]);
  });
});
