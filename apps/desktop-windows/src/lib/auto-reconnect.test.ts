import { describe, expect, it } from "vitest";
import type { AttemptReport } from "./attempts";
import { LADDER_MAX_MS } from "./ladder-pass";
import {
  asReconnectReport,
  ATTEMPT_MAX_MS,
  AutoReconnect,
  BLOCKED_WAIT_MAX_MS,
  QUICK_DEATH_MS,
  QUICK_DEATHS_TO_STOP,
  RECONNECT_BACKOFF_MS,
  RECONNECT_BUDGET_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_REASON_PREFIX,
  reconnectingView,
  reconnectLost,
  reconnectOutcomeOf,
  type ReconnectAttempt,
  type ReconnectOutcome,
} from "./auto-reconnect";

/** A controller on a clock the test owns.
 *
 * Timers are a list the test walks with `advance`, so "an attempt starts
 * two seconds after the first one failed" is an assertion about numbers
 * rather than about how long the test happened to sleep. The runner is
 * scripted per attempt: an outcome, and how long the pass takes. */
function harness({ requiresForeground = false }: { requiresForeground?: boolean } = {}) {
  const start = 1_000_000;
  const state = { now: start, online: true, foreground: true, session: 1 };
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const reports: AttemptReport[] = [];
  const rc = new AutoReconnect({
    now: () => state.now,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: state.now + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    online: () => state.online,
    foreground: () => state.foreground,
    session: () => state.session,
    report: (report) => reports.push(report),
  });
  rc.setRequiresForeground(requiresForeground);

  /** Every attempt the runner was asked for, with when it started. */
  const asked: (ReconnectAttempt & { at: number })[] = [];
  /** What each attempt does: its outcome and how long it takes. The last
   * entry repeats. A `pending` entry never answers until `settle`. */
  let script: ({ outcome: ReconnectOutcome; takesMs?: number } | "pending")[] = [{ outcome: { kind: "failed" } }];
  let settle: ((o: ReconnectOutcome) => void) | null = null;

  const runner = (attempt: ReconnectAttempt): Promise<ReconnectOutcome> => {
    asked.push({ ...attempt, at: state.now - start });
    const step = script[Math.min(asked.length - 1, script.length - 1)]!;
    if (step === "pending") {
      return new Promise((resolve) => {
        settle = resolve;
      });
    }
    const { outcome, takesMs = 0 } = step;
    if (takesMs === 0) return Promise.resolve(outcome);
    return new Promise((resolve) => {
      const id = nextTimer++;
      timers.set(id, { at: state.now + takesMs, fn: () => resolve(outcome) });
    });
  };

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  /** Moves the clock, firing every timer that falls due on the way, in
   * order, and letting the promises they settle run. */
  const advance = async (ms: number) => {
    const end = state.now + ms;
    for (;;) {
      await flush();
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of timers) {
        if (entry[1].at <= end && (due === null || entry[1].at < due[1].at)) due = entry;
      }
      if (due === null) break;
      timers.delete(due[0]);
      state.now = due[1].at;
      due[1].fn();
    }
    state.now = end;
    await flush();
  };

  return {
    rc,
    state,
    reports,
    asked,
    advance,
    flush,
    elapsed: () => state.now - start,
    script: (next: typeof script) => {
      script = next;
    },
    settle: (o: ReconnectOutcome) => settle?.(o),
    bind: () => rc.bind(runner),
  };
}

describe("a tunnel that drops on its own is reconnected", () => {
  it("starts the first pass at once, leading with the route that was up", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "route-fi", fresh: true });
    await h.advance(5 * 60_000);
    h.script([{ outcome: { kind: "connected", routeId: "route-fi" } }]);

    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(0);

    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ attempt: 1, maxAttempts: RECONNECT_MAX_ATTEMPTS, resumeRouteId: "route-fi" });
    expect(h.asked[0]!.at).toBe(5 * 60_000);
    // Landed: armed again, nothing said about losing anything.
    expect(h.rc.current().kind).toBe("armed");
    expect(reconnectLost(h.rc.current())).toBe(false);
  });

  it("does nothing for a tunnel it was never told about", async () => {
    // Control for the rule above: without `tunnelUp` there is nothing
    // armed, so a drop is exactly what it was before this feature --
    // "VPN connection lost" and a Connect button.
    const h = harness();
    h.bind();
    expect(h.rc.dropped()).toBe("lost");
    await h.advance(10 * 60_000);
    expect(h.asked).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
  });
});

describe("the backoff", () => {
  it("is immediate, then 2s, 5s, 10s, 20s, 30s -- and then it gives up", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    const droppedAt = h.elapsed();
    h.rc.dropped();
    await h.advance(10 * 60_000);

    // Each pass fails at once, so the gaps are the backoff alone.
    const starts = h.asked.map((a) => a.at - droppedAt);
    expect(starts).toEqual([0, 2_000, 7_000, 17_000, 37_000, 67_000]);
    expect(h.asked.map((a) => a.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(h.rc.current()).toEqual({ kind: "idle", lost: true, stopped: "attempts" });
    // Said once, and said as an automatic reconnect.
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ kind: "CONNECT", outcome: "OTHER" });
    expect(h.reports[0]!.reason).toMatch(new RegExp(`^${RECONNECT_REASON_PREFIX} stopped after 6 attempt`));
  });

  it("stops starting passes once about two minutes have gone on them", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    // A filtered network: every pass dials for thirty seconds and fails.
    h.script([{ outcome: { kind: "failed" }, takesMs: 30_000 }]);
    const droppedAt = h.elapsed();
    h.rc.dropped();
    await h.advance(10 * 60_000);

    // 0 + 30 run; 2 waited, 30 run (62); 5, 30 (97); 10, 30 (137): the
    // fifth would wait 20 more on top of 137 -- past the budget.
    expect(h.asked.map((a) => a.at - droppedAt)).toEqual([0, 32_000, 67_000, 107_000]);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "budget" });
    expect(h.reports[0]!.reason).toContain("stopped after 4 attempt(s)");
  });

  it("never interrupts a pass for the budget", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    // One pass longer than the whole budget, and it lands.
    h.script([{ outcome: { kind: "connected", routeId: "r" }, takesMs: RECONNECT_BUDGET_MS + 30_000 }]);
    h.rc.dropped();
    await h.advance(RECONNECT_BUDGET_MS + 60_000);
    expect(h.asked).toHaveLength(1);
    expect(h.rc.current().kind).toBe("armed");
  });

  it("has the shape the owner asked for", () => {
    expect(RECONNECT_BACKOFF_MS[0]).toBe(0);
    for (let i = 1; i < RECONNECT_BACKOFF_MS.length; i++) {
      expect(RECONNECT_BACKOFF_MS[i]!).toBeGreaterThan(RECONNECT_BACKOFF_MS[i - 1]!);
    }
    expect(RECONNECT_BUDGET_MS).toBe(120_000);
    expect(QUICK_DEATHS_TO_STOP).toBe(3);
  });
});

describe("an engine that dies the moment it starts", () => {
  it("is rebuilt twice and then left, with no tight loop", async () => {
    const h = harness();
    h.bind();
    h.script([{ outcome: { kind: "connected", routeId: "r" } }]);
    h.rc.tunnelUp({ routeId: "r", fresh: true });

    // Dies five seconds in, every time.
    await h.advance(5_000);
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(5_000);
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(5_000);
    expect(h.rc.dropped()).toBe("lost");
    await h.advance(10 * 60_000);

    expect(h.asked).toHaveLength(QUICK_DEATHS_TO_STOP - 1);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "quickDeaths" });
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.reason).toMatch(new RegExp(`^${RECONNECT_REASON_PREFIX} not attempted`));
  });

  it("counts only deaths in a row: a tunnel that held resets the count", async () => {
    // Control: the same three drops, the middle tunnel lasting longer
    // than QUICK_DEATH_MS, reconnect every time.
    const h = harness();
    h.bind();
    h.script([{ outcome: { kind: "connected", routeId: "r" } }]);
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(5_000);
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(QUICK_DEATH_MS + 1_000);
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(5_000);
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(5_000);
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(0);
    expect(h.asked).toHaveLength(4);
  });

  it("keeps the clock of a tunnel it already knew when the screen re-reads it", async () => {
    // A remount, or the transient recheck, reports the same tunnel again.
    // That is not a new session; the clock must not restart, or an
    // engine dying at second 50 would never count as quick.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(30_000);
    h.rc.tunnelUp({ routeId: null });
    await h.advance(40_000);
    // 70s since it came up: not quick, whatever the second report said.
    const armed = h.rc.current();
    expect(armed.kind).toBe("armed");
    if (armed.kind === "armed") expect(h.elapsed() - (armed.since - 1_000_000)).toBe(70_000);
  });
});

describe("no network, or no foreground", () => {
  it("waits for the network instead of burning attempts", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.state.online = false;
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(10 * 60_000);

    expect(h.asked).toHaveLength(0);
    expect(reconnectingView(h.rc.current())).toEqual({ offline: true, waiting: true });

    h.script([{ outcome: { kind: "connected", routeId: "r" } }]);
    h.state.online = true;
    h.rc.conditionsChanged();
    await h.advance(0);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]!.attempt).toBe(1);
    expect(h.rc.current().kind).toBe("armed");
  });

  it("pauses a backoff when the network goes, and goes at once when it is back", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0); // attempt 1 fails at once; attempt 2 due in 2s
    expect(h.asked).toHaveLength(1);

    h.state.online = false;
    h.rc.conditionsChanged();
    await h.advance(60_000);
    expect(h.asked).toHaveLength(1);

    h.state.online = true;
    h.rc.conditionsChanged();
    await h.advance(0);
    expect(h.asked.map((a) => a.attempt)).toEqual([1, 2]);
  });

  it("does not charge the offline wait to the two-minute budget", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.state.online = false;
    h.rc.dropped();
    await h.advance(5 * 60_000);
    h.state.online = true;
    h.rc.conditionsChanged();
    await h.advance(10 * 60_000);
    // The full six, five minutes offline notwithstanding.
    expect(h.asked).toHaveLength(RECONNECT_MAX_ATTEMPTS);
    expect(h.rc.current()).toMatchObject({ stopped: "attempts" });
  });

  it("gives up after half an hour without a network", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.state.online = false;
    h.rc.dropped();
    await h.advance(BLOCKED_WAIT_MAX_MS - 1_000);
    expect(h.rc.current().kind).toBe("waiting");
    await h.advance(2_000);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "waitedTooLong" });
    // And a network coming back after that brings nothing up on its own.
    h.state.online = true;
    h.rc.conditionsChanged();
    await h.advance(60_000);
    expect(h.asked).toHaveLength(0);
  });

  it("on a phone, waits for the app to be in front", async () => {
    const h = harness({ requiresForeground: true });
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.state.foreground = false;
    h.rc.dropped();
    await h.advance(5 * 60_000);
    expect(h.asked).toHaveLength(0);
    expect(h.rc.current()).toMatchObject({ kind: "waiting", blockedBy: "foreground" });

    h.state.foreground = true;
    h.rc.conditionsChanged();
    await h.advance(0);
    expect(h.asked).toHaveLength(1);
  });

  it("on Windows, a window in the background is no reason to wait", async () => {
    // Control for the rule above.
    const h = harness({ requiresForeground: false });
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.state.foreground = false;
    h.rc.dropped();
    await h.advance(0);
    expect(h.asked).toHaveLength(1);
  });
});

describe("the customer outranks it", () => {
  it("a press during the wait ends the episode, and nothing runs after", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0); // attempt 1 failed; attempt 2 is due in 2s
    h.rc.cancel("customer");
    await h.advance(10 * 60_000);
    expect(h.asked).toHaveLength(1);
    // The press has its own outcome to show; no "lost" on its behalf.
    expect(h.rc.current()).toEqual({ kind: "idle", lost: false, stopped: "customer" });
  });

  it("a press during a pass wins over whatever that pass reports later", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(0);
    expect(h.rc.current().kind).toBe("attempting");

    h.rc.cancel("customer");
    h.settle({ kind: "connected", routeId: "r" });
    await h.advance(10 * 60_000);
    expect(h.rc.current()).toMatchObject({ kind: "idle", stopped: "customer" });
    expect(h.asked).toHaveLength(1);
  });

  it("Stop reconnecting leaves 'connection lost' up, until the next press", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0);
    h.rc.cancel("stopped");
    expect(reconnectLost(h.rc.current())).toBe(true);
    // A second call cannot re-word it...
    h.rc.cancel("attempts");
    expect(h.rc.current()).toMatchObject({ stopped: "stopped" });
    // ...but the customer's next press is the news now.
    h.rc.cancel("customer");
    expect(reconnectLost(h.rc.current())).toBe(false);
  });

  it("a tunnel the customer asked to be rid of is not armed again by a re-read", async () => {
    // A Disconnect whose teardown did not finish: the tunnel is still up,
    // and the screen, back from Settings, adopts it. Its later death is
    // not something to reconnect -- the customer asked for it down.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.cancel("customer");
    h.rc.tunnelUp({ routeId: null });
    expect(h.rc.dropped()).toBe("lost");
    await h.advance(60_000);
    expect(h.asked).toHaveLength(0);
    // Control: a tunnel the app has just brought up again is armed.
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    expect(h.rc.current().kind).toBe("armed");
    // And on a fresh app, an adopted tunnel is armed too.
    const fresh = harness();
    fresh.rc.tunnelUp({ routeId: null });
    expect(fresh.rc.current().kind).toBe("armed");
  });

  it("a Disconnect while connected disarms, so a later death is not reconnected", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.cancel("customer");
    expect(h.rc.dropped()).toBe("lost");
    await h.advance(60_000);
    expect(h.asked).toHaveLength(0);
    // Disarming is not an episode, and says nothing.
    expect(h.reports).toHaveLength(0);
  });
});

describe("what rules a reconnect out", () => {
  it("never reconnects across a sign-out, and says nothing about it", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.state.session = 2;
    expect(h.rc.dropped()).toBe("lost");
    await h.advance(60_000);
    expect(h.asked).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
  });

  it("stops between attempts if the session ends during the backoff", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0);
    h.state.session = 2;
    await h.advance(60_000);
    expect(h.asked).toHaveLength(1);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: false, stopped: "signedOut" });
  });

  it("takes the screen's word that this moment rules it out", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    expect(h.rc.dropped({ exclusion: "refused" })).toBe("lost");
    await h.advance(60_000);
    expect(h.asked).toHaveLength(0);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "refused" });
    expect(h.reports[0]!.reason).toMatch(new RegExp(`^${RECONNECT_REASON_PREFIX} not attempted`));
  });

  it("stops at a refusal from the plan's device limit, mid-episode", async () => {
    const h = harness();
    h.bind();
    h.script([{ outcome: { kind: "failed" } }, { outcome: { kind: "stop", why: "refused" } }]);
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(10 * 60_000);
    expect(h.asked).toHaveLength(2);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "refused" });
  });
});

describe("what is not a new drop", () => {
  it("a second death during an episode does not start a second one", async () => {
    // A failed pass can leave an engine up, shown as "degraded"; when it
    // dies the screen reports a drop again. The episode carries on with
    // its own count rather than starting over at attempt one.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0); // attempt 1 failed; attempt 2 due in 2s
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(2_000);
    expect(h.asked.map((a) => a.attempt)).toEqual([1, 2]);
  });

  it("a tunnel the app took down itself is forgotten, not reconnected", async () => {
    // The mid-session failover tears the armed tunnel down on purpose;
    // when it lands nothing, the screen forgets it.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.forget();
    expect(h.rc.dropped()).toBe("lost");
    await h.advance(60_000);
    expect(h.asked).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
  });

  it("forgetting leaves an episode alone", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0);
    h.rc.forget();
    await h.advance(2_000);
    expect(h.asked).toHaveLength(2);
  });
});

describe("a pass that never comes back", () => {
  it("is counted as failed after a ceiling, so the episode cannot hang on it", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(ATTEMPT_MAX_MS - 1_000);
    expect(h.rc.current().kind).toBe("attempting");
    await h.advance(2_000);
    // Past the ceiling, and past the budget with it: the episode ends,
    // and says the connection was lost.
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "budget" });
    // What the wedged pass says afterwards changes nothing.
    h.settle({ kind: "connected", routeId: "r" });
    await h.advance(0);
    expect(h.rc.current()).toMatchObject({ kind: "idle", stopped: "budget" });
  });

  it("is waited for as long as a live pass can take", () => {
    // Longer than a pass's own guard: no live pass is given up on.
    expect(ATTEMPT_MAX_MS).toBeGreaterThan(LADDER_MAX_MS);
  });
});

describe("a screen that is not there", () => {
  it("holds a due attempt until a dashboard binds, then runs it", async () => {
    const h = harness();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(30_000);
    expect(h.asked).toHaveLength(0);
    expect(h.rc.current().kind).toBe("waiting");
    h.bind();
    await h.advance(0);
    expect(h.asked).toHaveLength(1);
  });

  it("stands down if a tunnel is up again before the next attempt", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0);
    h.rc.tunnelUp({ routeId: null });
    await h.advance(60_000);
    expect(h.asked).toHaveLength(1);
    expect(h.rc.current().kind).toBe("armed");
  });
});

describe("telemetry", () => {
  const attempt: ReconnectAttempt = { attempt: 2, maxAttempts: 6, resumeRouteId: "r" };

  it("keeps a pass that landed a SUCCESS, marked automatic", () => {
    const report = asReconnectReport({ kind: "CONNECT", outcome: "SUCCESS", protocol: "Stealth", routeId: "r" }, attempt);
    expect(report.outcome).toBe("SUCCESS");
    expect(report.kind).toBe("CONNECT");
    expect(report.reason).toBe(`${RECONNECT_REASON_PREFIX} attempt 2 of at most 6 after the tunnel dropped`);
  });

  it("files a pass that did not land as OTHER, keeping what it would have been", () => {
    const report = asReconnectReport(
      { kind: "CONNECT", outcome: "NOT_CARRYING_TRAFFIC", reason: "tried 2 of 5 available", attempts: [] },
      attempt,
    );
    expect(report.outcome).toBe("OTHER");
    expect(report.reason!.startsWith(RECONNECT_REASON_PREFIX)).toBe(true);
    expect(report.reason).toContain("NOT_CARRYING_TRAFFIC");
    expect(report.reason).toContain("tried 2 of 5 available");
    expect(report.attempts).toEqual([]);
  });

  it("leaves a customer's own connect exactly as it was", () => {
    const own: AttemptReport = { kind: "CONNECT", outcome: "NOT_CARRYING_TRAFFIC", reason: "x" };
    expect(asReconnectReport(own, undefined)).toBe(own);
  });

  it("uses only values the current backend accepts", () => {
    // The DTO's enums are fixed; a new kind would be a 400, which `send`
    // counts as delivered and drops.
    const success = asReconnectReport({ kind: "CONNECT", outcome: "SUCCESS" }, attempt);
    const failure = asReconnectReport({ kind: "CONNECT", outcome: "ENGINE_FAILED" }, attempt);
    for (const r of [success, failure]) {
      expect(["REGISTER", "SIGN_IN", "CONNECT", "SESSION"]).toContain(r.kind);
      expect(r.reason!.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("a ladder pass, as an attempt's outcome", () => {
  it("maps every way a pass can end", () => {
    expect(reconnectOutcomeOf("connected", { routeId: "r" })).toEqual({ kind: "connected", routeId: "r" });
    expect(reconnectOutcomeOf("failed")).toEqual({ kind: "failed" });
    expect(reconnectOutcomeOf("failed", { errorKind: "serverUnreachable" })).toEqual({ kind: "failed" });
    expect(reconnectOutcomeOf("declined")).toEqual({ kind: "failed" });
    expect(reconnectOutcomeOf("refused")).toEqual({ kind: "stop", why: "refused" });
    expect(reconnectOutcomeOf("cancelled")).toEqual({ kind: "stop", why: "customer" });
    expect(reconnectOutcomeOf("unusable")).toEqual({ kind: "stop", why: "excluded" });
  });

  it("stops on what only the plan can change", () => {
    for (const kind of ["concurrentLimit", "quotaExhausted", "subscriptionInactive"]) {
      expect(reconnectOutcomeOf("failed", { errorKind: kind })).toEqual({ kind: "stop", why: "notEntitled" });
    }
  });
});

describe("what the screen is told", () => {
  it("has a view only while an episode runs", () => {
    expect(reconnectingView({ kind: "idle", lost: true, stopped: "attempts" })).toBeNull();
    expect(reconnectingView({ kind: "armed", since: 0, routeId: null, quickDeaths: 0, session: 1 })).toBeNull();
    const episode = { routeId: null, quickDeaths: 0, session: 1, droppedAt: 0, spentMs: 0 };
    expect(
      reconnectingView({ kind: "attempting", attempt: 0, startedAt: 0, episode }),
    ).toEqual({ offline: false, waiting: false });
    expect(
      reconnectingView({ kind: "waiting", attempt: 1, dueAt: 0, delayMs: 2_000, blockedBy: null, blockedSince: null, episode }),
    ).toEqual({ offline: false, waiting: true });
  });
});
