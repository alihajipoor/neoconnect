import { describe, expect, it } from "vitest";
import {
  OFFLINE_RETRY_BACKOFF_MS,
  OFFLINE_RETRY_EVERY_MS,
  OfflineRetry,
  offlineRetryDelay,
  RESUME_RETRY_GAP_MS,
  type OfflineRetryTrigger,
} from "./offline-retry";

/** A dashboard on its cached snapshot asking Neoxify again.
 *
 * The VM run this answers: every block lifted, the window in front, and
 * for 150 seconds no request went out and the banner went on saying
 * "Can't reach Neoxify right now". These drive the schedule on a clock of
 * their own, with loads that answer when the test says so. */

/** A clock and a timer queue, run by hand. */
function harness(options: { hidden?: boolean; busy?: boolean } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const state = { hidden: options.hidden ?? false, busy: options.busy ?? false };
  /** Every load made, with what started it, when, and how to end it. */
  const loads: {
    why: OfflineRetryTrigger;
    at: number;
    end: (answered: boolean) => void;
    fail: (err: Error) => void;
  }[] = [];
  const retry = new OfflineRetry({
    load: (why) =>
      new Promise<boolean>((resolve, reject) => {
        loads.push({ why, at: now, end: resolve, fail: reject });
      }),
    busy: () => state.busy,
    hidden: () => state.hidden,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
  /** Moves the clock on, firing every timer that falls due, in order. */
  async function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = until;
  }
  /** Lets a load's answer reach the schedule. */
  async function settle() {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }
  /** Ends the load in flight. */
  async function answer(answered: boolean) {
    const last = loads[loads.length - 1];
    last.end(answered);
    await settle();
  }
  return { retry, loads, state, advance, answer, settle, pending: () => timers.size, now: () => now };
}

describe("the schedule", () => {
  it("asks at 15, 30 and 60 seconds, then every two minutes", () => {
    expect(OFFLINE_RETRY_BACKOFF_MS).toEqual([15_000, 30_000, 60_000]);
    expect(OFFLINE_RETRY_EVERY_MS).toBe(120_000);
    expect([0, 1, 2, 3, 4, 10].map(offlineRetryDelay)).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 120_000]);
  });

  it("makes the load again on that schedule while nothing answers it", async () => {
    const h = harness();
    h.retry.start();
    // Each wait is counted from the end of the load before; these end at
    // once.
    for (const wait of [15_000, 30_000, 60_000, 120_000, 120_000]) {
      const before = h.loads.length;
      await h.advance(wait - 1);
      expect(h.loads).toHaveLength(before);
      await h.advance(1);
      expect(h.loads).toHaveLength(before + 1);
      await h.answer(false);
    }
    expect(h.loads.map((l) => l.at)).toEqual([15_000, 45_000, 105_000, 225_000, 345_000]);
    expect(h.loads.every((l) => l.why === "timer")).toBe(true);
    expect(h.retry.isActive()).toBe(true);
  });

  /** The VM's case: the block lifts twenty seconds after the fallback, and
   * the window stays in front. Before, nothing asked again at all. */
  it("notices a block lifting within the backoff, with the window left alone", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    expect(h.loads).toHaveLength(1);
    await h.answer(false); // still blocked at 15 s
    await h.advance(30_000);
    expect(h.loads).toHaveLength(2);
    expect(h.loads[1].at).toBe(45_000);
    await h.answer(true); // lifted at 20 s: this one is answered
    expect(h.retry.isActive()).toBe(false);
    await h.advance(600_000);
    expect(h.loads).toHaveLength(2);
    expect(h.pending()).toBe(0);
  });

  it("asks nothing before the first step, and nothing once stopped", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(14_999);
    expect(h.loads).toHaveLength(0);
    h.retry.stop();
    await h.advance(600_000);
    expect(h.loads).toHaveLength(0);
  });

  it("keeps its place when started again while already retrying", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(10_000);
    h.retry.start();
    await h.advance(5_000);
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0].at).toBe(15_000);
  });
});

describe("never more than one load", () => {
  it("does not start another while one is under way, whatever asks", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    expect(h.loads).toHaveLength(1);
    h.retry.trigger("answered");
    h.retry.trigger("online");
    h.retry.trigger("tunnel");
    h.retry.trigger("resume");
    await h.advance(600_000);
    expect(h.loads).toHaveLength(1);
  });

  it("waits for a load of the screen's own, and does not count that as a failure", async () => {
    const h = harness();
    h.retry.start();
    h.state.busy = true;
    await h.advance(15_000);
    expect(h.loads).toHaveLength(0);
    h.retry.trigger("online");
    expect(h.loads).toHaveLength(0);
    h.state.busy = false;
    // Rescheduled at the same step, not the next one.
    await h.advance(15_000);
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0].at).toBe(30_000);
  });

  it("treats a load that throws as one that got no answer", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    h.loads[0].fail(new Error("boom"));
    await h.settle();
    expect(h.retry.isActive()).toBe(true);
    await h.advance(30_000);
    expect(h.loads).toHaveLength(2);
  });
});

describe("asking at once", () => {
  it("asks at once when the network comes back, a tunnel is verified, or Neoxify answers something else", async () => {
    for (const why of ["online", "tunnel", "answered"] as const) {
      const h = harness();
      h.retry.start();
      await h.advance(1_000);
      h.retry.trigger(why);
      expect(h.loads.map((l) => [l.why, l.at])).toEqual([[why, 1_000]]);
      // Answered: the screen has its data, and nothing more is asked.
      await h.answer(true);
      expect(h.retry.isActive()).toBe(false);
    }
  });

  it("goes on with the backoff when what it asked at once is not answered", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(1_000);
    h.retry.trigger("online");
    await h.answer(false);
    // One load has failed, so the next is the second step after it.
    await h.advance(29_999);
    expect(h.loads).toHaveLength(1);
    await h.advance(1);
    expect(h.loads).toHaveLength(2);
    expect(h.loads[1].at).toBe(31_000);
  });

  it("ignores every reason to ask while the screen is not on its snapshot", async () => {
    const h = harness();
    h.retry.trigger("answered");
    h.retry.trigger("tunnel");
    h.retry.trigger("online");
    expect(h.loads).toHaveLength(0);
  });

  it("asks on coming back to the front, but not on every click of a window", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    await h.answer(false);
    // Focused again two seconds after that load began: not asked again.
    await h.advance(2_000);
    h.retry.trigger("resume");
    expect(h.loads).toHaveLength(1);
    // Past the gap: asked.
    await h.advance(RESUME_RETRY_GAP_MS);
    h.retry.trigger("resume");
    expect(h.loads).toHaveLength(2);
    expect(h.loads[1].why).toBe("resume");
  });
});

describe("while hidden", () => {
  it("asks nothing while the app is out of sight, and asks on coming back", async () => {
    const h = harness({ hidden: true });
    h.retry.start();
    await h.advance(600_000);
    expect(h.loads).toHaveLength(0);
    h.retry.trigger("online");
    expect(h.loads).toHaveLength(0);
    h.state.hidden = false;
    h.retry.trigger("resume");
    expect(h.loads.map((l) => l.why)).toEqual(["resume"]);
  });

  it("makes the load that fell due while hidden on coming back, and then goes on with the schedule", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    await h.answer(false);
    h.state.hidden = true;
    await h.advance(300_000);
    // Fell due at 45 s, and was not made; nothing else was scheduled.
    expect(h.loads).toHaveLength(1);
    expect(h.pending()).toBe(0);
    h.state.hidden = false;
    h.retry.trigger("resume");
    expect(h.loads).toHaveLength(2);
    expect(h.loads[1].at).toBe(315_000);
    await h.answer(false);
    await h.advance(60_000);
    expect(h.loads).toHaveLength(3);
  });
});

describe("after the screen has gone", () => {
  /** A load that ends after its screen unmounted -- a sign-out while it
   * waited -- must not start a schedule nothing will ever stop. */
  it("starts nothing once detached, until attached again", async () => {
    const h = harness();
    h.retry.start();
    h.retry.detach();
    expect(h.retry.isActive()).toBe(false);
    h.retry.start();
    await h.advance(600_000);
    expect(h.loads).toHaveLength(0);
    h.retry.attach();
    h.retry.start();
    await h.advance(15_000);
    expect(h.loads).toHaveLength(1);
  });

  it("schedules nothing after a load that was under way when it went", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    h.retry.detach();
    await h.answer(false);
    await h.advance(600_000);
    expect(h.loads).toHaveLength(1);
    expect(h.pending()).toBe(0);
  });
});
