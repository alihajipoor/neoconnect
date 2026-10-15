import {
  BUCKET_MS,
  bucketStart,
  capRefusal,
  evaluateDrop,
  powBits,
  stepSuspicion,
  type SuspicionState,
  type TrafficCounts,
} from "./relay-policy";

describe("relay sign-up policy", () => {
  describe("proof of work", () => {
    it("never asks less than 18 bits", () => {
      expect(powBits({ ipLastHour: 0, globalLastHour: 0, installToday: 0 })).toBe(18);
    });

    it("adds two bits per sign of pressure", () => {
      expect(powBits({ ipLastHour: 3, globalLastHour: 0, installToday: 0 })).toBe(20);
      expect(powBits({ ipLastHour: 0, globalLastHour: 50, installToday: 0 })).toBe(20);
      expect(powBits({ ipLastHour: 0, globalLastHour: 0, installToday: 3 })).toBe(20);
      expect(powBits({ ipLastHour: 9, globalLastHour: 70, installToday: 4 })).toBe(24);
      expect(powBits({ ipLastHour: 2, globalLastHour: 49, installToday: 2 })).toBe(18);
    });
  });

  describe("caps", () => {
    const counts = { total: 0, network: 0, hosting: 0, caller: 0 };

    it("holds the day at 200 normally and 3,000 in the intranet tier", () => {
      expect(capRefusal("normal", false, { ...counts, total: 199 })).toBeNull();
      expect(capRefusal("normal", false, { ...counts, total: 200 })).toBe("global");
      expect(capRefusal("intranet", false, { ...counts, total: 200 })).toBeNull();
      expect(capRefusal("intranet", false, { ...counts, total: 3_000 })).toBe("global");
    });

    it("holds one caller at 30 a day", () => {
      expect(capRefusal("intranet", false, { ...counts, total: 100, caller: 29 })).toBeNull();
      expect(capRefusal("intranet", false, { ...counts, total: 100, caller: 30 })).toBe("caller");
    });

    it("holds one network at a quarter of the day", () => {
      expect(capRefusal("normal", false, { ...counts, total: 60, network: 49 })).toBeNull();
      expect(capRefusal("normal", false, { ...counts, total: 60, network: 50 })).toBe("network");
      expect(capRefusal("intranet", false, { ...counts, total: 800, network: 750 })).toBe("network");
    });

    it("holds every hosting network together at 5%", () => {
      expect(capRefusal("normal", true, { ...counts, total: 10, network: 3, hosting: 9 })).toBeNull();
      expect(capRefusal("normal", true, { ...counts, total: 10, network: 3, hosting: 10 })).toBe("hosting");
      expect(capRefusal("intranet", true, { ...counts, total: 150, hosting: 150 })).toBe("hosting");
    });
  });
});

describe("auto detector", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 9, 15, 12, 4);
  const end = bucketStart(now);

  /** A week of the same traffic in the half hour before `now`, and
   * `current` in that half hour today. */
  function week(baseline: TrafficCounts, current: TrafficCounts, days = 7): Map<number, TrafficCounts> {
    const buckets = new Map<number, TrafficCounts>();
    for (let i = 1; i <= 3; i += 1) {
      buckets.set(end - i * BUCKET_MS, { ir: current.ir / 3, other: current.other / 3 });
      for (let d = 1; d <= days; d += 1) {
        buckets.set(end - d * DAY - i * BUCKET_MS, { ir: baseline.ir / 3, other: baseline.other / 3 });
      }
    }
    return buckets;
  }

  it("sees Iranian traffic fall away while the rest holds", () => {
    const reading = evaluateDrop(week({ ir: 300, other: 600 }, { ir: 30, other: 570 }), now);
    expect(reading).toMatchObject({ ir: 30, other: 570, irMedian: 300, otherMedian: 600, holds: true });
  });

  it("does not call our own outage an intranet: when everything drops, it does not hold", () => {
    expect(evaluateDrop(week({ ir: 300, other: 600 }, { ir: 20, other: 100 }), now).holds).toBe(false);
  });

  it("does not hold on a dip that is not deep enough", () => {
    expect(evaluateDrop(week({ ir: 300, other: 600 }, { ir: 50, other: 600 }), now).holds).toBe(false);
  });

  it("does not judge without a baseline", () => {
    expect(evaluateDrop(week({ ir: 300, other: 600 }, { ir: 0, other: 600 }, 3), now).holds).toBe(false);
    expect(evaluateDrop(week({ ir: 10, other: 600 }, { ir: 0, other: 600 }), now).holds).toBe(false);
  });

  describe("its state", () => {
    const clear: SuspicionState = { suspectedSince: null, suspicionAlertedAt: null, capsRaisedAt: null };
    const at = (minutes: number) => new Date(now + minutes * 60_000);

    it("alerts after 30 minutes, raises the caps after 60, once each", () => {
      let state = clear;
      const events: string[] = [];
      for (const minute of [0, 5, 29, 30, 35, 59, 60, 65]) {
        const step = stepSuspicion(state, true, at(minute));
        state = step.next;
        events.push(...step.events.map((e) => `${minute}:${e}`));
      }
      expect(events).toEqual(["30:alert", "60:raise"]);
      expect(state.capsRaisedAt).toEqual(at(60));
    });

    it("stands down when the drop ends, and says so only if it had alerted", () => {
      const alerted = { suspectedSince: at(0), suspicionAlertedAt: at(30), capsRaisedAt: at(60) };
      expect(stepSuspicion(alerted, false, at(70))).toEqual({ next: clear, events: ["clear"] });
      const quiet = { suspectedSince: at(0), suspicionAlertedAt: null, capsRaisedAt: null };
      expect(stepSuspicion(quiet, false, at(10))).toEqual({ next: clear, events: [] });
      expect(stepSuspicion(clear, false, at(10))).toEqual({ next: clear, events: [] });
    });

    it("starts over after an interruption", () => {
      let state = stepSuspicion(clear, true, at(0)).next;
      state = stepSuspicion(state, false, at(20)).next;
      const resumed = stepSuspicion(state, true, at(25));
      expect(resumed.next.suspectedSince).toEqual(at(25));
      expect(stepSuspicion(resumed.next, true, at(50)).events).toEqual([]);
    });
  });
});
