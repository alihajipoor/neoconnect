import { describe, expect, it } from "vitest";
import type { AttemptReport } from "./attempts";
import { LADDER_MAX_MS } from "./ladder-pass";
import {
  asReconnectReport,
  ATTEMPT_MAX_MS,
  AutoReconnect,
  BLOCKED_WAIT_MAX_MS,
  passStopped,
  QUICK_DEATH_MS,
  QUICK_DEATHS_TO_STOP,
  RECONNECT_BACKOFF_MS,
  RECONNECT_BUDGET_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_REASON_PREFIX,
  reconnectingView,
  reconnectLost,
  reconnectOutcomeOf,
  slotStopWhy,
  vouching,
  type ReconnectAttempt,
  type ReconnectOutcome,
} from "./auto-reconnect";
import { slotStop } from "./device-slot-session";
import type { DeviceLimitRefusal } from "./device-slots";

/** A controller on a clock the test owns.
 *
 * Timers are a list the test walks with `advance`, so "an attempt starts
 * two seconds after the first one failed" is an assertion about numbers
 * rather than about how long the test happened to sleep. The runner is
 * scripted per attempt: an outcome, and how long the pass takes.
 *
 * `state.now` is the clock timers run on, which only goes forward -- and
 * the controller's own such clock (`elapsed`); `wallSkew` is how far the
 * wall clock (`Date.now()`, its `now`) has been set away from it. */
function harness({ requiresForeground = false }: { requiresForeground?: boolean } = {}) {
  const start = 1_000_000;
  const state = { now: start, wallSkew: 0, online: true, foreground: true, session: 1 };
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const reports: AttemptReport[] = [];
  /** Each time the controller said nothing will claim the slot soon. */
  const slotIdled: ("ended" | "away")[] = [];
  const rc = new AutoReconnect({
    now: () => state.now + state.wallSkew,
    elapsed: () => state.now,
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
    slotIdle: (how) => slotIdled.push(how),
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
    slotIdled,
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
    h.rc.tunnelUp({ routeId: "route-fi", fresh: true, stamp: h.rc.stamp() });
    await h.advance(5 * 60_000);
    h.script([{ outcome: { kind: "connected", routeId: "route-fi" } }]);

    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(0);

    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ attempt: 1, maxAttempts: RECONNECT_MAX_ATTEMPTS, resumeRouteId: "route-fi" });
    expect(h.asked[0]!.at).toBe(5 * 60_000);
    // Landed: armed again, nothing said about losing anything.
    expect(h.rc.current().kind).toBe("armed");
    expect(reconnectLost(h.rc.current(), h.state.session)).toBe(false);
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    const droppedAt = h.elapsed();
    h.rc.dropped();
    await h.advance(10 * 60_000);

    // Each pass fails at once, so the gaps are the backoff alone.
    const starts = h.asked.map((a) => a.at - droppedAt);
    expect(starts).toEqual([0, 2_000, 7_000, 17_000, 37_000, 67_000]);
    expect(h.asked.map((a) => a.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(h.rc.current()).toEqual({ kind: "idle", lost: true, stopped: "attempts", session: 1 });
    // Said once, and said as an automatic reconnect.
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ kind: "CONNECT", outcome: "OTHER" });
    expect(h.reports[0]!.reason).toMatch(new RegExp(`^${RECONNECT_REASON_PREFIX} stopped after 6 attempt`));
  });

  it("stops starting passes once about two minutes have gone on them", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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

  it("starts the next pass when its backoff timer fires, though the wall clock was set back meanwhile", async () => {
    // Timers run on a clock that only goes forward; `Date.now()` steps --
    // a time sync, a phone's network time, the customer correcting it.
    // The attempt used to be due only once `Date.now()` reached a deadline
    // taken from `Date.now()`: set back by one millisecond during the wait,
    // the timer's firing read as early, nothing ran, nothing was
    // rescheduled, and the screen said "Reconnecting..." for good.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0); // attempt 1 failed; attempt 2 due in 2s
    h.state.wallSkew = -1;
    await h.advance(RECONNECT_BACKOFF_MS[1]!);
    expect(h.asked.map((a) => a.attempt)).toEqual([1, 2]);
    // And the episode runs its course from there, however far back.
    h.state.wallSkew = -60 * 60_000;
    await h.advance(10 * 60_000);
    expect(h.asked).toHaveLength(RECONNECT_MAX_ATTEMPTS);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "attempts" });
  });

  it("never interrupts a pass for the budget", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });

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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.state.online = false;
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(10 * 60_000);

    expect(h.asked).toHaveLength(0);
    expect(reconnectingView(h.rc.current(), 1)).toEqual({ offline: true, waiting: true });

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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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

  it("still gives up when the clock jumped past the ceiling with no timer firing", async () => {
    // A laptop asleep, or a phone app frozen in the background: timers do
    // not run, and the first thing that happens on waking is the network
    // (or the app) coming back. Hours later is not a blip to reconnect.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.state.online = false;
    h.rc.dropped();
    h.state.now += BLOCKED_WAIT_MAX_MS + 60_000;
    h.state.online = true;
    h.rc.conditionsChanged();
    await h.flush();
    expect(h.asked).toHaveLength(0);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "waitedTooLong" });
  });

  it("on a phone, waits for the app to be in front", async () => {
    const h = harness({ requiresForeground: true });
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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

  it("on a phone, does not charge the time in the background to a pass that was running", async () => {
    // The customer opens the app on "Reconnecting..." and switches away
    // three seconds into a pass, which the OS freezes; back two and a half
    // minutes later, the pass fails. Charged by the wall clock, that was
    // 155 s of a 120 s budget: "VPN connection lost", five attempts unspent.
    const h = harness({ requiresForeground: true });
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(3_000);
    h.state.foreground = false;
    h.rc.conditionsChanged();
    await h.advance(150_000);
    h.state.foreground = true;
    h.rc.conditionsChanged();
    await h.advance(2_000);
    expect(h.rc.current().kind).toBe("attempting");
    h.script([{ outcome: { kind: "failed" } }]);
    h.settle({ kind: "failed" });
    await h.advance(0);
    expect(h.rc.current()).toMatchObject({ kind: "waiting", attempt: 1, blockedBy: null });
    await h.advance(10 * 60_000);
    expect(h.asked).toHaveLength(RECONNECT_MAX_ATTEMPTS);
    expect(h.rc.current()).toMatchObject({ stopped: "attempts" });
  });

  it("on a phone, holds the attempt's ceiling while the app is in the background", async () => {
    // Away for longer than the ceiling, it fell due in the background: the
    // episode ended on the budget beneath a pass about to go on dialling,
    // and the tunnel that pass landed was armed by nothing.
    const h = harness({ requiresForeground: true });
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(3_000);
    h.state.foreground = false;
    h.rc.conditionsChanged();
    await h.advance(10 * 60_000);
    expect(h.rc.current().kind).toBe("attempting");
    h.state.foreground = true;
    h.rc.conditionsChanged();
    // What was left of the ceiling when it went, from the moment it is
    // back: three seconds of it were spent in front.
    await h.advance(ATTEMPT_MAX_MS - 3_000 - 1_000);
    expect(h.asked[0]!.live()).toBe(true);
    h.settle({ kind: "connected", routeId: "r" });
    await h.advance(0);
    expect(h.rc.current().kind).toBe("armed");
    expect(h.reports).toHaveLength(0);
    // Control: in front, a silent pass is still given up on.
    h.script(["pending"]);
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(ATTEMPT_MAX_MS + 1_000);
    expect(h.rc.current()).toMatchObject({ kind: "idle", stopped: "budget" });
  });

  it("on a phone, goes on from what was left of the ceiling each time the app is back, not afresh", async () => {
    // A customer who kept leaving and coming back -- ten seconds away every
    // 170 s in front -- had the whole ceiling started again at each return,
    // so a wedged pass was never given up on: "Reconnecting..." for as long
    // as they kept it up, with nothing going to dial again.
    const h = harness({ requiresForeground: true });
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(0);
    const wedged = h.asked[0]!;
    for (let i = 0; i < 10 && h.rc.current().kind === "attempting"; i++) {
      await h.advance(170_000);
      h.state.foreground = false;
      h.rc.conditionsChanged();
      await h.advance(10_000);
      h.state.foreground = true;
      h.rc.conditionsChanged();
    }
    // Given up on once 180 s in front had gone without a sign of life --
    // the second return had ten seconds of it left -- and that far in, the
    // budget is spent with it.
    expect(wedged.live()).toBe(false);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "budget" });

    // Control: a pass that shows a sign of life in each stretch in front is
    // waited for however often the customer comes and goes.
    const l = harness({ requiresForeground: true });
    l.bind();
    l.rc.tunnelUp({ routeId: "r", fresh: true, stamp: l.rc.stamp() });
    await l.advance(10 * 60_000);
    l.script(["pending"]);
    l.rc.dropped();
    await l.advance(0);
    for (let i = 0; i < 10; i++) {
      await l.advance(170_000);
      l.asked[0]!.progress();
      l.state.foreground = false;
      l.rc.conditionsChanged();
      await l.advance(10_000);
      l.state.foreground = true;
      l.rc.conditionsChanged();
    }
    expect(l.asked[0]!.live()).toBe(true);
  });

  it("on a phone, charges the ceiling for its time in front on a clock that only goes forward", async () => {
    // The wall clock steps -- a phone's network time, on the very network
    // change that dropped the tunnel. Read there, a forward step of five
    // minutes ate the whole ceiling in a five-second trip away, and the
    // live pass was given up on the moment the app came back.
    const h = harness({ requiresForeground: true });
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(10_000);
    h.state.wallSkew += 5 * 60_000;
    await h.advance(10_000);
    h.state.foreground = false;
    h.rc.conditionsChanged();
    await h.advance(5_000);
    h.state.foreground = true;
    h.rc.conditionsChanged();
    await h.advance(1_000);
    expect(h.asked[0]!.live()).toBe(true);
    // Twenty seconds of it went in front: the rest runs from the return.
    await h.advance(ATTEMPT_MAX_MS - 20_000 - 3_000);
    expect(h.asked[0]!.live()).toBe(true);
    await h.advance(3_000);
    expect(h.asked[0]!.live()).toBe(false);
  });

  it("on a phone, holds it too when the ceiling falls due before the move to the background was heard", async () => {
    // A phone can freeze the app before its visibility change is handled.
    const h = harness({ requiresForeground: true });
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(3_000);
    h.state.foreground = false;
    await h.advance(ATTEMPT_MAX_MS + 60_000);
    expect(h.rc.current().kind).toBe("attempting");
    h.state.foreground = true;
    h.rc.conditionsChanged();
    await h.advance(ATTEMPT_MAX_MS - 1_000);
    expect(h.rc.current().kind).toBe("attempting");
    await h.advance(2_000);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true });
  });

  it("on a phone, ends an attempt the app was away from for half an hour, as it ends a wait", async () => {
    // Timers running in the background (Android need not freeze the app).
    const h = harness({ requiresForeground: true });
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(3_000);
    h.state.foreground = false;
    h.rc.conditionsChanged();
    await h.advance(BLOCKED_WAIT_MAX_MS - 1_000);
    expect(h.rc.current().kind).toBe("attempting");
    await h.advance(2_000);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "waitedTooLong" });
    expect(h.asked[0]!.live()).toBe(false);
    // What the pass says on waking changes nothing.
    h.state.foreground = true;
    h.rc.conditionsChanged();
    h.settle({ kind: "connected", routeId: "r" });
    await h.advance(0);
    expect(h.rc.current()).toMatchObject({ kind: "idle", stopped: "waitedTooLong" });

    // Frozen: no timer runs until the app is back, an hour later.
    const f = harness({ requiresForeground: true });
    f.bind();
    f.rc.tunnelUp({ routeId: "r", fresh: true, stamp: f.rc.stamp() });
    await f.advance(10 * 60_000);
    f.script(["pending"]);
    f.rc.dropped();
    await f.advance(3_000);
    f.state.foreground = false;
    f.rc.conditionsChanged();
    f.state.now += 60 * 60_000;
    f.state.foreground = true;
    f.rc.conditionsChanged();
    expect(f.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "waitedTooLong" });
    expect(f.asked[0]!.live()).toBe(false);

    // A pass that failed in the background leaves a wait blocked since the
    // app went there, not since the failure: half an hour in all.
    const b = harness({ requiresForeground: true });
    b.bind();
    b.rc.tunnelUp({ routeId: "r", fresh: true, stamp: b.rc.stamp() });
    await b.advance(10 * 60_000);
    b.script([{ outcome: { kind: "failed" }, takesMs: 10 * 60_000 }]);
    b.rc.dropped();
    await b.advance(0);
    b.state.foreground = false;
    b.rc.conditionsChanged();
    await b.advance(10 * 60_000);
    expect(b.rc.current()).toMatchObject({ kind: "waiting", attempt: 1, blockedBy: "foreground" });
    await b.advance(BLOCKED_WAIT_MAX_MS - 10 * 60_000 + 1_000);
    expect(b.rc.current()).toMatchObject({ kind: "idle", stopped: "waitedTooLong" });
    expect(b.asked).toHaveLength(1);
  });

  it("on Windows, a window in the background is no reason to wait", async () => {
    // Control for the rule above.
    const h = harness({ requiresForeground: false });
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0); // attempt 1 failed; attempt 2 is due in 2s
    h.rc.cancel("customer");
    await h.advance(10 * 60_000);
    expect(h.asked).toHaveLength(1);
    // The press has its own outcome to show; no "lost" on its behalf.
    expect(h.rc.current()).toEqual({ kind: "idle", lost: false, stopped: "customer", session: null });
  });

  it("a press during a pass wins over whatever that pass reports later", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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

  it("tells a pass still asking questions that a press has ended its attempt, before it dials", async () => {
    // The phone's pass asks the platform two things before it dials. A
    // stop pressed meanwhile used to be ignored: the outcome was dropped,
    // but the tunnel came up anyway. The attempt now says it is over, for
    // good, the moment anything ends it -- whichever screen pressed.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(0);
    const first = h.asked[0]!;
    expect(first.live()).toBe(true);
    h.rc.cancel("stopped");
    expect(first.live()).toBe(false);
    // A later episode's attempt is its own; the old one stays over.
    h.settle({ kind: "failed" });
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    h.rc.dropped();
    await h.advance(0);
    expect(h.asked).toHaveLength(2);
    expect(h.asked[1]!.live()).toBe(true);
    expect(first.live()).toBe(false);
  });

  it("tells it the same when the attempt moves on without a press", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(0);
    const wedged = h.asked[0]!;
    // The attempt's own ceiling: counted as failed (and, that far in, the
    // budget is spent with it).
    await h.advance(ATTEMPT_MAX_MS);
    expect(h.rc.current().kind).not.toBe("attempting");
    expect(wedged.live()).toBe(false);

    // A session that ended where no screen could tell the episode.
    const s = harness();
    s.bind();
    s.rc.tunnelUp({ routeId: "r", fresh: true, stamp: s.rc.stamp() });
    await s.advance(10 * 60_000);
    s.script(["pending"]);
    s.rc.dropped();
    await s.advance(0);
    expect(s.asked[0]!.live()).toBe(true);
    s.state.session += 1;
    expect(s.asked[0]!.live()).toBe(false);
  });

  it("stops a pass dialling for an episode a press ended, whichever press, flag or no flag", async () => {
    // Windows' ladder asked only the stop flag, which a repair, a new
    // location and a change of mode never set: they ended the episode and
    // the pass went on dialling the old order behind them. `passStopped`
    // asks the attempt too.
    const ends: [string, (h: ReturnType<typeof harness>) => void][] = [
      ["a repair, or a change of mode", (h) => h.rc.cancel("customer")],
      ["a new location", (h) => void h.rc.chose({ tunnelShown: false })],
      ["Stop reconnecting", (h) => h.rc.cancel("stopped")],
      ["a session that ended out of sight", (h) => (h.state.session += 1)],
    ];
    for (const [press, end] of ends) {
      const h = harness();
      h.bind();
      h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
      await h.advance(10 * 60_000);
      h.script(["pending"]);
      h.rc.dropped();
      await h.advance(0);
      const attempt = h.asked[0]!;
      expect(passStopped(false, attempt), press).toBe(false);
      end(h);
      expect(passStopped(false, attempt), press).toBe(true);
    }
    // The flag stops any pass; the customer's own connect is not held to
    // an episode it is not part of.
    expect(passStopped(true, undefined)).toBe(true);
    expect(passStopped(false, undefined)).toBe(false);
  });

  it("a new location chosen between attempts ends the episode, and nothing runs after", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0); // attempt 1 failed; attempt 2 is due in 2s
    expect(h.rc.chose({ tunnelShown: false })).toBeNull();
    await h.advance(10 * 60_000);
    expect(h.asked).toHaveLength(1);
    expect(h.rc.current()).toEqual({ kind: "idle", lost: false, stopped: "customer", session: null });
  });

  it("one chosen during an attempt ends it and asks the screen to stop its pass", async () => {
    // Ended alone, the pass went on dialling, led by the old route, and
    // landed there under a screen already naming the new one.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(0);
    expect(h.rc.chose({ tunnelShown: false })).toBe("stopPass");
    expect(h.asked[0]!.live()).toBe(false);
    h.settle({ kind: "connected", routeId: "r" });
    await h.advance(10 * 60_000);
    expect(h.rc.current()).toMatchObject({ kind: "idle", stopped: "customer" });
    expect(h.asked).toHaveLength(1);
  });

  it("one chosen over a tunnel that came back beneath the list leaves it up and still reconnected", async () => {
    // The list opens only while nothing is up; a reconnect can land while
    // it is open. Taken as a press that takes over, the choice disarmed
    // that tunnel, and its next drop said "VPN connection lost". The
    // choice is for the next connect; the tunnel up is the same one.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    const asked = h.rc.stamp();
    expect(h.rc.chose({ tunnelShown: true })).toBe("keepTunnel");
    expect(vouching(h.rc.current(), 1)).toBe(true);
    // Nothing was overruled: an answer asked for before it still arms.
    h.rc.tunnelUp({ routeId: null, stamp: asked });
    expect(h.rc.current().kind).toBe("armed");
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(0);
    expect(h.asked).toHaveLength(1);
    expect(h.reports).toHaveLength(0);
  });

  it("and that tunnel's reconnect leads with the choice, not the route the customer chose to leave", async () => {
    // Kept armed on the old route, the episode led its automatic pass with
    // it -- ahead of the pin (`orderCandidates`) -- while the tile, with
    // nothing up, named the new choice. With no route to resume, the pass
    // takes the ordinary order, the choice first.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "old", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    expect(h.rc.chose({ tunnelShown: true })).toBe("keepTunnel");
    // A screen mounting re-reads the same tunnel, and names no route.
    h.rc.tunnelUp({ routeId: null, stamp: h.rc.stamp() });
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(0);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]!.resumeRouteId).toBeNull();

    // Control: with nothing chosen, it leads with the route that was up.
    const c = harness();
    c.bind();
    c.rc.tunnelUp({ routeId: "old", fresh: true, stamp: c.rc.stamp() });
    await c.advance(10 * 60_000);
    c.rc.dropped();
    await c.advance(0);
    expect(c.asked[0]!.resumeRouteId).toBe("old");
  });

  it("one chosen while the customer's own connect dials leaves that connect's landing armed", async () => {
    // The list answers once its switch request has, which can be after the
    // customer closed it and pressed Connect. Counted as an overrule, the
    // choice disowned that connect's landing (`stamp`): Connected on
    // screen, nothing armed, and its drop said "VPN connection lost" and
    // reconnected nothing. The choice does not stop that connect, so it
    // does not disown it either.
    const h = harness();
    h.bind();
    // An earlier episode ended without a tunnel: "VPN connection lost".
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    expect(h.rc.dropped({ exclusion: "excluded" })).toBe("lost");
    expect(reconnectLost(h.rc.current(), 1)).toBe(true);
    // The customer's connect begins, as a press: the words are retired.
    h.rc.cancel("customer");
    const connect = h.rc.stamp();
    expect(h.rc.chose({ tunnelShown: false })).toBeNull();
    h.rc.tunnelUp({ routeId: "new", fresh: true, stamp: connect });
    expect(vouching(h.rc.current(), 1)).toBe(true);
    await h.advance(10 * 60_000);
    expect(h.rc.dropped()).toBe("reconnecting");
    await h.advance(0);
    expect(h.asked).toHaveLength(1);

    // The choice still retires an old "VPN connection lost", as any press.
    const l = harness();
    l.rc.tunnelUp({ routeId: "r", fresh: true, stamp: l.rc.stamp() });
    await l.advance(10 * 60_000);
    l.rc.dropped({ exclusion: "excluded" });
    expect(reconnectLost(l.rc.current(), 1)).toBe(true);
    expect(l.rc.chose({ tunnelShown: false })).toBeNull();
    expect(reconnectLost(l.rc.current(), 1)).toBe(false);
  });

  it("one chosen while armed beneath a screen that shows nothing up takes over, and nothing redials", async () => {
    // Armed while the screen says "disconnected": a Windows health-poll
    // reading that was not a drop, or a phone screen that could not ask the
    // platform. Kept armed, the choice's own reload found the tunnel gone,
    // took it for a drop it had missed, and reconnected -- the old route
    // first -- right after the customer chose a new server.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "old", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    expect(h.rc.chose({ tunnelShown: false })).toBeNull();
    expect(vouching(h.rc.current(), 1)).toBe(false);
    // What the reload then does with "nothing is running".
    expect(h.rc.dropped()).toBe("lost");
    await h.advance(10 * 60_000);
    expect(h.asked).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
  });

  it("Stop reconnecting leaves 'connection lost' up, until the next press", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0);
    h.rc.cancel("stopped");
    expect(reconnectLost(h.rc.current(), h.state.session)).toBe(true);
    // A second call cannot re-word it...
    h.rc.cancel("attempts");
    expect(h.rc.current()).toMatchObject({ stopped: "stopped" });
    // ...but the customer's next press is the news now.
    h.rc.cancel("customer");
    expect(reconnectLost(h.rc.current(), h.state.session)).toBe(false);
  });

  it("a tunnel the customer asked to be rid of is not armed again by a re-read", async () => {
    // A Disconnect whose teardown did not finish: the tunnel is still up,
    // and the screen, back from Settings, adopts it. Its later death is
    // not something to reconnect -- the customer asked for it down.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.cancel("customer");
    h.rc.tunnelUp({ routeId: null });
    expect(h.rc.dropped()).toBe("lost");
    await h.advance(60_000);
    expect(h.asked).toHaveLength(0);
    // Control: a tunnel the app has just brought up again is armed.
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    expect(h.rc.current().kind).toBe("armed");
    // And on a fresh app, an adopted tunnel is armed too.
    const fresh = harness();
    fresh.rc.tunnelUp({ routeId: null });
    expect(fresh.rc.current().kind).toBe("armed");
  });

  it("a Disconnect while connected disarms, so a later death is not reconnected", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.cancel("customer");
    expect(h.rc.dropped()).toBe("lost");
    await h.advance(60_000);
    expect(h.asked).toHaveLength(0);
    // Disarming is not an episode, and says nothing.
    expect(h.reports).toHaveLength(0);
  });

  it("a connect the customer stopped arms nothing, though its verdict comes back after the stop", async () => {
    // Stopped on "Checking connection...": the request already in flight
    // through the tunnel answers before the stop's teardown lands, and the
    // pass lands. Armed, the screen back from Settings found the tunnel the
    // stop took down gone, said "VPN connection lost" and dialled.
    const h = harness();
    h.bind();
    h.rc.cancel("customer"); // Connect
    const pass = h.rc.stamp();
    h.rc.cancel("customer"); // the stop, while it verifies
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: pass });
    expect(h.rc.current().kind).toBe("idle");
    expect(vouching(h.rc.current(), 1)).toBe(false);
    expect(h.rc.dropped()).toBe("lost");
    await h.advance(60_000);
    expect(h.asked).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
    // Control: the next connect, which nothing has overruled, is armed.
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    expect(h.rc.current().kind).toBe("armed");
  });

  it("nor does any pass that something else overruled while it dialled", () => {
    // "Stop reconnecting", a sign-out, the device limit, a repair or a
    // change of server from a screen the pass cannot reach -- whatever
    // phase each finds the controller in.
    for (const why of ["customer", "stopped", "signedOut", "refused"] as const) {
      for (const armedBefore of [false, true]) {
        const h = harness();
        if (armedBefore) h.rc.tunnelUp({ routeId: "old", fresh: true, stamp: h.rc.stamp() });
        const pass = h.rc.stamp();
        h.rc.cancel(why);
        h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: pass });
        expect(h.rc.current().kind, `${why}, armed before: ${armedBefore}`).toBe("idle");
      }
    }
  });

  it("nor a re-read that something overruled while the service was asked", () => {
    // The answer named a tunnel the press is taking down -- here a
    // sign-out, which a re-read's idle guard alone let through.
    const h = harness();
    const asked = h.rc.stamp();
    h.rc.cancel("signedOut");
    h.rc.tunnelUp({ routeId: null, stamp: asked });
    expect(h.rc.current().kind).toBe("idle");
    // Control: asked again afterwards, it is armed.
    h.rc.tunnelUp({ routeId: null, stamp: h.rc.stamp() });
    expect(h.rc.current().kind).toBe("armed");
  });

  it("an overruled answer leaves an episode that began after it alone", async () => {
    const h = harness();
    h.bind();
    const stale = h.rc.stamp();
    h.rc.cancel("customer");
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0); // attempt 1 failed; attempt 2 due in 2s
    expect(h.rc.current().kind).toBe("waiting");
    h.rc.tunnelUp({ routeId: null, stamp: stale });
    expect(h.rc.current().kind).toBe("waiting");
    await h.advance(2_000);
    expect(h.asked).toHaveLength(2);
  });
});

describe("what rules a reconnect out", () => {
  it("never reconnects across a sign-out, and says nothing about it", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0);
    h.state.session = 2;
    await h.advance(60_000);
    expect(h.asked).toHaveLength(1);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: false, stopped: "signedOut" });
  });

  it("ends an attempt whose session ended out of sight as a sign-out, filing nothing, whatever its pass made of that", async () => {
    // A 401 whose refresh was refused ends the session from App, which no
    // press reaches. The attempt is no longer live, and a pass reads that as
    // a press having overtaken it -- the phone's preflight answers "the
    // customer", a ladder "cancelled" -- which was then filed as "the
    // customer pressed something", about somebody who had pressed nothing.
    const outcomes: ReconnectOutcome[] = [{ kind: "stop", why: "customer" }, { kind: "failed" }];
    for (const outcome of outcomes) {
      const h = harness();
      h.bind();
      h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
      await h.advance(10 * 60_000);
      h.script(["pending"]);
      h.rc.dropped();
      await h.advance(0);
      h.state.session += 1;
      h.settle(outcome);
      await h.advance(60_000);
      expect(h.rc.current(), outcome.kind).toMatchObject({ kind: "idle", lost: false, stopped: "signedOut" });
      expect(h.reports, outcome.kind).toHaveLength(0);
      expect(h.asked).toHaveLength(1);
    }
  });

  it("arms nothing for a pass that lands after its session ended", () => {
    // Ended out of sight -- a refresh refused, with no press to reach the
    // pass. Armed at landing, it was armed under the session in force then:
    // the next sign-in's, since only a session ending moves the count, and
    // that sign-in's first screen found the tunnel gone and dialled.
    const h = harness();
    const pass = h.rc.stamp();
    h.state.session = 2;
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: pass });
    expect(h.rc.current().kind).toBe("idle");
    expect(vouching(h.rc.current(), 2)).toBe(false);
  });

  it("takes the screen's word that this moment rules it out", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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

  it("waits out a long pass that is still dialling, and arms the tunnel it lands", async () => {
    // A filtered network and eight or so credentials: every rung is a sign
    // of life, and the pass is still going at three minutes. The ceiling
    // used to run from the start: it ended the episode on the budget
    // beneath the pass, and the tunnel the pass then landed was armed by
    // nothing, so its next drop was not reconnected.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(0);
    const pass = h.asked[0]!;
    // A rung a minute, for five minutes.
    for (let rung = 0; rung < 5; rung++) {
      await h.advance(60_000);
      pass.progress();
    }
    expect(h.rc.current().kind).toBe("attempting");
    expect(pass.live()).toBe(true);
    expect(h.reports).toHaveLength(0);
    h.settle({ kind: "connected", routeId: "r2" });
    await h.advance(0);
    expect(h.rc.current()).toMatchObject({ kind: "armed", routeId: "r2" });
    // Armed, so its own drop is reconnected in turn.
    await h.advance(10 * 60_000);
    expect(h.rc.dropped()).toBe("reconnecting");
  });

  it("gives up on one a whole ceiling after its last sign of life, not after its start", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.script(["pending"]);
    h.rc.dropped();
    await h.advance(0);
    const pass = h.asked[0]!;
    await h.advance(100_000);
    pass.progress();
    await h.advance(ATTEMPT_MAX_MS - 1_000);
    expect(h.rc.current().kind).toBe("attempting");
    await h.advance(2_000);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "budget" });
    expect(pass.live()).toBe(false);
    // A sign of life from a pass already given up on revives nothing.
    pass.progress();
    h.settle({ kind: "connected", routeId: "r" });
    await h.advance(10 * 60_000);
    expect(h.rc.current()).toMatchObject({ kind: "idle", stopped: "budget" });
  });

  it("is waited for as long as a live pass can take", () => {
    // Both measured from the pass's last sign of life, and the attempt's
    // the longer: no pass the guard still counts as live is given up on.
    expect(ATTEMPT_MAX_MS).toBeGreaterThan(LADDER_MAX_MS);
  });
});

describe("a screen that is not there", () => {
  it("holds a due attempt until a dashboard binds, then runs it", async () => {
    const h = harness();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(30_000);
    expect(h.asked).toHaveLength(0);
    expect(h.rc.current().kind).toBe("waiting");
    h.bind();
    await h.advance(0);
    expect(h.asked).toHaveLength(1);
  });

  it("holds an overdue attempt through a screen's load, and runs it as the same attempt", async () => {
    // The dashboard unmounts for Settings mid-episode; the next backoff
    // falls due while it is away, and the screen mounted on return takes
    // seconds to load (8 s per endpoint on a filtered API) before it
    // binds. Nothing is spent meanwhile: the attempt it then runs is the
    // one that was due, and the episode carries on from there.
    const h = harness();
    const unbind = h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0);
    expect(h.asked).toHaveLength(1);
    unbind();
    await h.advance(RECONNECT_BACKOFF_MS[1]! + 20_000);
    expect(h.asked).toHaveLength(1);
    expect(h.rc.current()).toMatchObject({ kind: "waiting", attempt: 1 });
    h.bind();
    await h.advance(0);
    expect(h.asked).toHaveLength(2);
    expect(h.asked[1]!.attempt).toBe(2);
    // The next one after its own backoff, as though nobody had left.
    await h.advance(RECONNECT_BACKOFF_MS[2]! - 1);
    expect(h.asked).toHaveLength(2);
    await h.advance(1);
    expect(h.asked).toHaveLength(3);
    expect(h.asked[2]!.attempt).toBe(3);
  });

  it("stands down if a tunnel is up again before the next attempt", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
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
  const attempt: ReconnectAttempt = {
    attempt: 2,
    maxAttempts: 6,
    resumeRouteId: "r",
    live: () => true,
    progress: () => undefined,
  };

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

  it("ends on the plan, not the device limit, when the slot's stop was the plan ending", () => {
    // A subscription that expired mid-session, with the app's copy still
    // saying ACTIVE: the reconnect's claim answers SUBSCRIPTION_INACTIVE,
    // and the episode's row said the device limit had refused the device.
    const ended = slotStop({ kind: "inactive", subscriptionStatus: "EXPIRED" }, "beforeDial");
    expect(reconnectOutcomeOf("refused", { errorKind: ended.errorKind })).toEqual({ kind: "stop", why: "notEntitled" });
    expect(slotStopWhy(ended.errorKind)).toBe("notEntitled");
    // The device limit itself, every way it can say so, stays the device
    // limit.
    const refusal = { limit: 1, devices: [] } as unknown as DeviceLimitRefusal;
    for (const reason of [
      { kind: "refused", refusal },
      { kind: "takeoverLimited", retryAfterSec: null },
      { kind: "displaced", by: null, at: null },
    ] as const) {
      const stop = slotStop(reason, "beforeDial");
      expect(reconnectOutcomeOf("refused", { errorKind: stop.errorKind })).toEqual({ kind: "stop", why: "refused" });
      expect(slotStopWhy(stop.errorKind)).toBe("refused");
    }
    expect(reconnectOutcomeOf("refused")).toEqual({ kind: "stop", why: "refused" });
  });

  it("files the plan's words for an episode the plan ended", async () => {
    const h = harness();
    h.bind();
    h.script([{ outcome: reconnectOutcomeOf("refused", { errorKind: "subscriptionInactive" }) }]);
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "notEntitled" });
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.reason).toContain("the plan does not allow a connection now");
    expect(h.reports[0]!.reason).not.toContain("device limit");
  });
});

describe("'VPN connection lost'", () => {
  it("is said only to the session whose tunnel dropped", async () => {
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(10 * 60_000);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "attempts" });
    expect(reconnectLost(h.rc.current(), 1)).toBe(true);
    // The session then ends by a way no press goes through -- revoked,
    // expired, the account deleted from Settings -- and somebody signs
    // in. Their first screen is not told a tunnel of theirs was lost.
    h.state.session = 2;
    expect(reconnectLost(h.rc.current(), 2)).toBe(false);
  });

  it("belongs to the session the drop happened under, even when the episode ends after it", async () => {
    // The session expired while the episode waited for a network, with no
    // press to tell it; the wait ran out half an hour later, by which time
    // the customer had signed in again.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.state.online = false;
    h.rc.dropped();
    await h.advance(60_000);
    h.state.session = 2;
    await h.advance(BLOCKED_WAIT_MAX_MS);
    expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: "waitedTooLong" });
    expect(reconnectLost(h.rc.current(), 2)).toBe(false);
  });
});

describe("the slot the drop kept for the reconnect's claim", () => {
  /** A tunnel up for ten minutes, then a drop. */
  async function dropped(h: ReturnType<typeof harness>) {
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    return h.rc.dropped();
  }

  it("is given back when the episode stops before any pass of it claimed", async () => {
    // Another VPN app took the phone over, the permission went, the plan
    // stopped, nothing to dial: nothing is coming back, and a slot kept
    // for nothing turned the customer's other device away as "in use on
    // Android phone" about a phone with no tunnel.
    for (const why of ["otherVpn", "permission", "notEntitled", "excluded"] as const) {
      const h = harness();
      h.script([{ outcome: { kind: "stop", why } }]);
      expect(await dropped(h)).toBe("reconnecting");
      // Kept while the reconnect's own claim is coming.
      expect(h.slotIdled).toEqual([]);
      await h.advance(0);
      expect(h.rc.current()).toMatchObject({ kind: "idle", lost: true, stopped: why });
      expect(h.slotIdled, why).toEqual(["ended"]);
    }
  });

  it("is given back when the episode has waited too long", async () => {
    const h = harness();
    h.state.online = false;
    await dropped(h);
    await h.advance(BLOCKED_WAIT_MAX_MS + 1_000);
    expect(h.rc.current()).toMatchObject({ stopped: "waitedTooLong" });
    expect(h.slotIdled).toEqual(["ended"]);
  });

  it("is left to whatever ended the episode when that accounts for it", async () => {
    // A press claims (Connect) or gives it back (Disconnect, Stop
    // reconnecting); a sign-out releases it on the server; after the
    // device limit it is somebody else's.
    for (const why of ["customer", "stopped", "signedOut", "refused"] as const) {
      const h = harness();
      await dropped(h);
      await h.advance(0);
      h.rc.cancel(why);
      expect(h.slotIdled, why).toEqual([]);
    }
    // The pass that failed last gave it back itself -- and one still
    // running past its ceiling may yet claim it, so it is not taken from
    // under it.
    const spent = harness();
    await dropped(spent);
    await spent.advance(10 * 60_000);
    expect(spent.rc.current()).toMatchObject({ stopped: "attempts" });
    const wedged = harness();
    wedged.script(["pending"]);
    await dropped(wedged);
    await wedged.advance(ATTEMPT_MAX_MS + 1_000);
    expect(wedged.rc.current()).toMatchObject({ stopped: "budget" });
    expect([...spent.slotIdled, ...wedged.slotIdled]).toEqual([]);
    // A refusal from the reconnect's own claim: the slot is not this
    // device's.
    const refused = harness();
    refused.script([{ outcome: { kind: "stop", why: "refused" } }]);
    await dropped(refused);
    await refused.advance(0);
    expect(refused.slotIdled).toEqual([]);
  });

  it("is the screen's to give back at a drop that starts no episode", async () => {
    // The screen is told "lost", and gives it back itself.
    const h = harness();
    h.bind();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    expect(h.rc.dropped({ exclusion: "notEntitled" })).toBe("lost");
    expect(h.slotIdled).toEqual([]);
  });

  it("on a phone, is set aside while the episode waits for the app to be opened", async () => {
    // A poll that ran in the background found the tunnel gone. Nothing
    // claims until the app is opened -- up to half an hour -- so the slot
    // is given back meanwhile, and the pass that runs then asks first.
    const h = harness({ requiresForeground: true });
    h.state.foreground = false;
    expect(await dropped(h)).toBe("reconnecting");
    expect(h.rc.current()).toMatchObject({ kind: "waiting", blockedBy: "foreground" });
    expect(h.slotIdled).toEqual(["away"]);
    await h.advance(10 * 60_000);
    expect(h.slotIdled).toEqual(["away"]);
    h.script([{ outcome: { kind: "connected", routeId: "r" } }]);
    h.state.foreground = true;
    h.rc.conditionsChanged();
    await h.advance(0);
    expect(h.rc.current().kind).toBe("armed");
    expect(h.slotIdled).toEqual(["away"]);
  });

  it("on a phone, is set aside too when the app goes to the background between attempts", async () => {
    const h = harness({ requiresForeground: true });
    await dropped(h);
    await h.advance(0); // attempt 1 failed; attempt 2 is due in 2s
    expect(h.slotIdled).toEqual([]);
    h.state.foreground = false;
    h.rc.conditionsChanged();
    expect(h.slotIdled).toEqual(["away"]);
  });

  it("is not set aside on Windows, nor while a phone's pass is running", async () => {
    // A minimised window is still a running app, and its next attempt
    // claims on time.
    const windows = harness();
    windows.state.foreground = false;
    await dropped(windows);
    await windows.advance(0);
    expect(windows.slotIdled).toEqual([]);
    // A pass the OS froze in the background holds its own claim.
    const phone = harness({ requiresForeground: true });
    phone.script(["pending"]);
    await dropped(phone);
    await phone.advance(0);
    phone.state.foreground = false;
    phone.rc.conditionsChanged();
    expect(phone.rc.current().kind).toBe("attempting");
    expect(phone.slotIdled).toEqual([]);
  });
});

describe("whether the app is vouching for a tunnel", () => {
  it("is, for an armed tunnel of the session in force", async () => {
    const h = harness();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    expect(vouching(h.rc.current(), 1)).toBe(true);
  });

  it("is not for one armed under a session that has since ended", () => {
    // An expired session ends from a screen that never says so, and can
    // leave a tunnel armed. Signed in again, the first screen must not
    // take the sign-out's own teardown for a drop.
    const h = harness();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    expect(vouching(h.rc.current(), 2)).toBe(false);
  });

  it("is not during an episode, nor when idle", async () => {
    const h = harness();
    h.bind();
    expect(vouching(h.rc.current(), 1)).toBe(false);
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    expect(vouching(h.rc.current(), 1)).toBe(false);
  });
});

describe("what the screen is told", () => {
  it("has a view only while an episode runs", () => {
    expect(reconnectingView({ kind: "idle", lost: true, stopped: "attempts", session: 1 }, 1)).toBeNull();
    expect(reconnectingView({ kind: "armed", since: 0, routeId: null, quickDeaths: 0, session: 1 }, 1)).toBeNull();
    const episode = { routeId: null, quickDeaths: 0, session: 1, droppedAt: 0, spentMs: 0 };
    expect(
      reconnectingView({ kind: "attempting", attempt: 0, startedAt: 0, episode }, 1),
    ).toEqual({ offline: false, waiting: false });
    expect(
      reconnectingView({ kind: "waiting", attempt: 1, delayMs: 2_000, blockedBy: null, blockedSince: null, episode }, 1),
    ).toEqual({ offline: false, waiting: true });
  });

  it("has none for an episode whose session has ended", async () => {
    // Its session ended out of sight -- an account deleted from Settings, a
    // refused refresh -- with the attempt held for a screen and no timer
    // left to move it on. The next sign-in's dashboard said
    // "Reconnecting...", with "Reconnect now" on the orb, until it had
    // loaded and its bind ended an episode nothing was going to dial for.
    const h = harness();
    h.rc.tunnelUp({ routeId: "r", fresh: true, stamp: h.rc.stamp() });
    await h.advance(10 * 60_000);
    h.rc.dropped();
    await h.advance(0);
    expect(h.rc.current()).toMatchObject({ kind: "waiting", attempt: 0 });
    expect(reconnectingView(h.rc.current(), 1)).toEqual({ offline: false, waiting: true });
    h.state.session = 2;
    expect(reconnectingView(h.rc.current(), 2)).toBeNull();
    // Nor while one of its passes still runs.
    const a = harness();
    a.bind();
    a.rc.tunnelUp({ routeId: "r", fresh: true, stamp: a.rc.stamp() });
    await a.advance(10 * 60_000);
    a.script(["pending"]);
    a.rc.dropped();
    await a.advance(0);
    expect(a.rc.current().kind).toBe("attempting");
    expect(reconnectingView(a.rc.current(), 1)).toEqual({ offline: false, waiting: false });
    expect(reconnectingView(a.rc.current(), 2)).toBeNull();
  });
});
