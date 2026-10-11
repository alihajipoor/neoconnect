import { describe, expect, it } from "vitest";
import {
  OFFLINE_RETRY_BACKOFF_MS,
  OFFLINE_RETRY_EVERY_MS,
  OfflineRetry,
  offlineRetryDelay,
  OWN_LOAD_EXPECTED_MS,
  reasonAfterUnansweredLoad,
  RESUME_RETRY_GAP_MS,
  type OfflineLoadOutcome,
  type OfflineRetryTrigger,
} from "./offline-retry";

/** A dashboard on its cached snapshot asking Neoxify again.
 *
 * The VM run this answers: every block lifted, the window in front, and
 * for 150 seconds no request went out and the banner went on saying
 * "Can't reach Neoxify right now". These drive the schedule on a clock of
 * their own, with loads that answer when the test says so. */

/** A clock and a timer queue, run by hand. */
function harness(options: { hidden?: boolean } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const state = { hidden: options.hidden ?? false };
  /** Every background load made, with what started it, when, and how to
   * end it. */
  const loads: {
    why: OfflineRetryTrigger;
    at: number;
    end: (outcome: OfflineLoadOutcome) => void;
    fail: (err: Error) => void;
  }[] = [];
  const retry = new OfflineRetry({
    load: (why) =>
      new Promise<OfflineLoadOutcome>((resolve, reject) => {
        loads.push({ why, at: now, end: resolve, fail: reject });
      }),
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
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }
  /** Ends the background load in flight. */
  async function answer(answered: boolean | OfflineLoadOutcome) {
    const last = loads[loads.length - 1];
    last.end(answered === true ? "answered" : answered === false ? "unanswered" : answered);
    await settle();
  }
  /** Begins one of the screen's own loads, as `loadAll` does, and returns
   * how to end it: with `fellBack`, the way a load that fell back to the
   * snapshot ends -- `start()` called before it returns -- and otherwise
   * as one that was answered, which calls `stop()`. */
  function own() {
    let finish: () => void = () => undefined;
    let fellBack = false;
    const done = retry.ownLoad(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }).then(() => {
          if (fellBack) retry.start();
          else retry.stop();
        }),
    );
    return {
      async fail() {
        fellBack = true;
        finish();
        await done;
        await settle();
      },
      async succeed() {
        finish();
        await done;
        await settle();
      },
    };
  }
  return { retry, loads, state, advance, answer, own, settle, pending: () => timers.size, now: () => now };
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
    await h.advance(5_000);
    expect(h.loads).toHaveLength(1);
  });

  it("waits for a load of the screen's own, and does not count that as a failure", async () => {
    const h = harness();
    h.retry.start();
    const load = h.own();
    await h.advance(15_000);
    expect(h.loads).toHaveLength(0);
    await load.fail();
    // Rescheduled at the same step when it fell due, not the next one.
    expect(h.loads).toHaveLength(0);
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

  /** A server switch's answer is one of Neoxify's. Asked about at once, it
   * started a background load a moment before the switch's own load began
   * beside it: two copies of the account, the plan and the credentials on
   * a censored network. */
  it("starts nothing between a server switch being sent and its load beginning", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(1_000);
    const switched = h.retry.expectOwnLoad();
    h.retry.trigger("answered"); // the switch's answer
    expect(h.loads).toHaveLength(0);
    // Its load begins, and only then is the wait called over.
    const load = h.own();
    switched();
    expect(h.loads).toHaveLength(0);
    // That load is the asking again for the switch's answer: answered, it
    // ends the retrying, and nothing more goes out.
    await load.succeed();
    await h.advance(600_000);
    expect(h.loads).toHaveLength(0);
    expect(h.retry.isActive()).toBe(false);
  });

  it("asks at once when the switch fails, for what came while it was out", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(1_000);
    const switched = h.retry.expectOwnLoad();
    h.retry.trigger("tunnel");
    expect(h.loads).toHaveLength(0);
    await h.advance(2_000);
    switched(); // failed: no load of the screen's own follows
    expect(h.loads.map((l) => [l.why, l.at])).toEqual([["tunnel", 3_000]]);
  });

  it("does not wait for a switch that never says how it ended for longer than its limit", async () => {
    const h = harness();
    h.retry.start();
    h.retry.expectOwnLoad();
    await h.advance(OWN_LOAD_EXPECTED_MS - 1);
    expect(h.loads).toHaveLength(0);
    await h.advance(15_001);
    expect(h.loads).toHaveLength(1);
  });
});

/** The VM's banner, back in a narrower race. A background load is sent
 * on the bare line, which drops Neoxify's addresses; a Connect meanwhile
 * is verified and its reports are answered through the tunnel; the old
 * load then fails. The tunnel's and the answer's reasons to ask were
 * dropped while it ran, and the next ask was up to two minutes away. */
describe("a reason to ask that comes while a load is under way", () => {
  it("is asked about the moment that load ends unanswered", async () => {
    const h = harness();
    h.retry.start();
    // Deep in the backoff, as a screen that has been on its snapshot for
    // a few minutes is: the next step is two minutes.
    for (const wait of [15_000, 30_000, 60_000]) {
      await h.advance(wait);
      await h.answer(false);
    }
    await h.advance(120_000);
    expect(h.loads).toHaveLength(4);
    const x = h.now();
    await h.advance(8_000);
    h.retry.trigger("tunnel");
    await h.advance(1_000);
    h.retry.trigger("answered");
    await h.advance(2_500);
    expect(h.loads).toHaveLength(4);
    await h.answer(false); // the bare-line load, at X + 11.5 s
    expect(h.loads).toHaveLength(5);
    expect(h.loads[4].at).toBe(x + 11_500);
    // The newest reason, once: not one load for each.
    expect(h.loads[4].why).toBe("answered");
    await h.answer(true);
    expect(h.retry.isActive()).toBe(false);
    await h.advance(600_000);
    expect(h.loads).toHaveLength(5);
  });

  it("is dropped when the load under way is answered", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    h.retry.trigger("tunnel");
    await h.answer(true);
    await h.advance(600_000);
    expect(h.loads).toHaveLength(1);
    expect(h.pending()).toBe(0);
  });

  it("is dropped, when it is an answer to a read, as the load's own", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    // The account answered and the plan did not: the load fails, and the
    // account's answer is no reason to make it again before the backoff.
    h.retry.trigger("answered", { ifLoading: "drop" });
    await h.answer(false);
    await h.advance(29_999);
    expect(h.loads).toHaveLength(1);
    await h.advance(1);
    expect(h.loads).toHaveLength(2);
  });

  it("is asked about when the screen's own load ends unanswered, while already retrying", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(1_000);
    const load = h.own();
    h.retry.trigger("tunnel");
    await h.advance(5_000);
    expect(h.loads).toHaveLength(0);
    await load.fail();
    expect(h.loads.map((l) => [l.why, l.at])).toEqual([["tunnel", 6_000]]);
  });

  /** At launch the snapshot goes up while the first load still waits on a
   * filtered path, and the customer connects. The claim is answered and
   * the tunnel verified while that load runs, before any retrying has
   * started; when it fails, the first ask used to be fifteen seconds
   * away. */
  it("is kept through the first load, before the retrying has started", async () => {
    const h = harness();
    const first = h.own();
    await h.advance(8_000);
    h.retry.trigger("answered");
    h.retry.trigger("tunnel");
    expect(h.loads).toHaveLength(0);
    await h.advance(15_000);
    await first.fail();
    expect(h.loads.map((l) => [l.why, l.at])).toEqual([["tunnel", 23_000]]);
  });

  it("is dropped when the screen's own load is answered", async () => {
    const h = harness();
    const first = h.own();
    h.retry.trigger("tunnel");
    await first.succeed();
    await h.advance(600_000);
    expect(h.loads).toHaveLength(0);
    // Nor kept for a later fall back to the snapshot.
    h.retry.start();
    expect(h.loads).toHaveLength(0);
  });

  it("is cleared by a load that begins after it, which is the asking again", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    h.retry.trigger("tunnel");
    // A server switch's load begins while the background one still runs.
    const load = h.own();
    await h.answer("superseded");
    await load.fail();
    // Nothing at once: the switch's load began after the tunnel and was
    // not answered either. The backoff, at the step it was at.
    expect(h.loads).toHaveLength(1);
    await h.advance(15_000);
    expect(h.loads).toHaveLength(2);
  });

  it("is kept while the app is hidden, and asked about on coming back, whatever the gap", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    await h.answer(false);
    h.state.hidden = true;
    await h.advance(1_000);
    h.retry.trigger("tunnel");
    expect(h.loads).toHaveLength(1);
    await h.advance(1_000);
    h.state.hidden = false;
    // Two seconds after the last load began: a resume alone would not ask.
    h.retry.trigger("resume");
    expect(h.loads).toHaveLength(2);
  });
});

describe("a load superseded by one of the screen's own", () => {
  /** A background load in flight; the customer switches server, and the
   * switch's load is answered and stops the retrying. The background
   * load, sent to a slow mirror, then fails -- and used to start the
   * retrying again on a screen no longer on its snapshot. */
  it("does not start the retrying again after the screen's own load was answered", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    const load = h.own();
    await load.succeed();
    expect(h.retry.isActive()).toBe(false);
    await h.answer("superseded");
    expect(h.retry.isActive()).toBe(false);
    await h.advance(600_000);
    expect(h.loads).toHaveLength(1);
  });

  it("is not counted as a failure", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    const load = h.own();
    await h.answer("superseded");
    await load.fail();
    // Still at the first step: fifteen seconds, not thirty.
    await h.advance(15_000);
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
    // And keeps none of them for later.
    h.retry.start();
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

  /** The resume that should make the load due while hidden arrives while
   * a load of the screen's own runs. It used to be refused, and the
   * retrying was left with no timer at all once that load failed. */
  it("makes the load due while hidden once a load of the screen's own that held up the resume ends", async () => {
    const h = harness();
    h.retry.start();
    await h.advance(15_000);
    await h.answer(false);
    h.state.hidden = true;
    await h.advance(300_000);
    expect(h.pending()).toBe(0);
    const load = h.own();
    h.state.hidden = false;
    h.retry.trigger("resume");
    expect(h.loads).toHaveLength(1);
    await h.advance(3_000);
    await load.fail();
    expect(h.loads.map((l) => [l.why, l.at])).toEqual([
      ["timer", 15_000],
      ["resume", 318_000],
    ]);
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
    h.retry.trigger("tunnel");
    h.retry.detach();
    await h.answer(false);
    await h.advance(600_000);
    expect(h.loads).toHaveLength(1);
    expect(h.pending()).toBe(0);
  });
});

describe("what the banner says after a load nothing answered", () => {
  it("says Neoxify was reached when it answered anything after the load began", () => {
    expect(reasonAfterUnansweredLoad("unreached", true)).toBe("reached");
  });

  it("says it could not be reached when nothing has answered since", () => {
    expect(reasonAfterUnansweredLoad("unreached", false)).toBe("unreached");
  });

  it("keeps an error the backend answered the load with, which is itself the newest answer", () => {
    const failure = { error: "Server error", status: 500 };
    expect(reasonAfterUnansweredLoad(failure, true)).toBe(failure);
  });
});
