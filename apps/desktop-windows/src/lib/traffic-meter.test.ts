import { describe, expect, it } from "vitest";
import { createTrafficMeter, readTraffic, SERIES_LENGTH, sparkPoints, STALE_AFTER_MS } from "./traffic-meter";

function meter() {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  const m = createTrafficMeter(
    () => now,
    {
      set: (fn, ms) => {
        const t = { at: now + ms, fn };
        timers.push(t);
        return t;
      },
      clear: (handle) => {
        const i = timers.indexOf(handle as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    },
  );
  return {
    m,
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
    get now() {
      return now;
    },
  };
}

const reading = (rx: number, tx: number, rates?: [number, number]) => ({
  rx_bytes: rx,
  tx_bytes: tx,
  ...(rates ? { rx_per_sec: rates[0], tx_per_sec: rates[1], window_ms: 1000 } : {}),
});

describe("the service's traffic field", () => {
  it("is read as the service sends it", () => {
    expect(readTraffic(reading(10, 2, [5, 1]))).toEqual({ rxBytes: 10, txBytes: 2, rxPerSec: 5, txPerSec: 1 });
    // Rates are left out until the service has measured one.
    expect(readTraffic(reading(10, 2))).toEqual({ rxBytes: 10, txBytes: 2, rxPerSec: null, txPerSec: null });
  });

  it("is nothing when nothing was read, or for a shape this app does not know -- never a zero", () => {
    expect(readTraffic(undefined)).toBeNull();
    expect(readTraffic(null)).toBeNull();
    expect(readTraffic({ rx_bytes: "10", tx_bytes: 2 })).toBeNull();
    expect(readTraffic({ rx_bytes: -1, tx_bytes: 2 })).toBeNull();
    expect(readTraffic({ tx_bytes: 2 })).toBeNull();
  });
});

describe("the speed section", () => {
  it("does not exist before anything was read", () => {
    const { m } = meter();
    expect(m.view()).toBeNull();
    expect(m.available()).toBe(false);
  });

  it("shows a dash, not a zero, until the service has measured a rate", () => {
    const { m } = meter();
    m.observe(reading(100, 50));
    expect(m.view()).toMatchObject({ rxPerSec: null, txPerSec: null, rxBytes: 100, txBytes: 50 });
  });

  it("shows a measured zero as a zero", () => {
    const { m } = meter();
    m.observe(reading(100, 50, [0, 0]));
    expect(m.view()).toMatchObject({ rxPerSec: 0, txPerSec: 0 });
  });

  it("keeps the last reading through one the service could not make, and leaves once it is stale", () => {
    const h = meter();
    const told: number[] = [];
    h.m.subscribe(() => told.push(h.now));
    h.m.observe(reading(100, 50, [2048, 512]));
    // A busy service's status carries no traffic: nothing changes.
    h.m.observe(undefined);
    h.advance(1_000);
    expect(h.m.view()?.rxPerSec).toBe(2048);
    h.advance(STALE_AFTER_MS);
    expect(h.m.view()).toBeNull();
    // Told when it went stale, so the section leaves on time.
    expect(told.length).toBe(2);
  });

  it("keeps a minute of measured rates for the sparkline, oldest first", () => {
    const h = meter();
    for (let i = 0; i < SERIES_LENGTH + 10; i += 1) {
      h.m.observe(reading(i * 100, i * 10, [i, i * 2]));
      h.advance(1_000);
    }
    const view = h.m.view(h.now - 500)!;
    expect(view.rxSeries).toHaveLength(SERIES_LENGTH);
    expect(view.rxSeries[0]).toBe(10);
    expect(view.rxSeries[SERIES_LENGTH - 1]).toBe(SERIES_LENGTH + 9);
    expect(view.txSeries[SERIES_LENGTH - 1]).toBe((SERIES_LENGTH + 9) * 2);
  });

  it("starts the next session from nothing", () => {
    const { m } = meter();
    m.observe(reading(100, 50, [10, 10]));
    m.reset();
    expect(m.view()).toBeNull();
    m.observe(reading(5, 5));
    expect(m.view()?.rxSeries).toEqual([]);
  });
});

describe("the sparkline", () => {
  it("is no line under two values", () => {
    expect(sparkPoints([], 60, 16)).toBe("");
    expect(sparkPoints([5], 60, 16)).toBe("");
  });

  it("ends at the right edge and scales to the largest value shown", () => {
    const points = sparkPoints([0, 4096, 2048], 60, 16).split(" ");
    expect(points).toHaveLength(3);
    expect(points[2]).toBe("60,8");
    expect(points[1].endsWith(",0")).toBe(true);
    expect(points[0].endsWith(",16")).toBe(true);
  });

  it("lies flat for an idle tunnel rather than magnifying a few bytes", () => {
    const ys = sparkPoints([1, 3, 2], 60, 16)
      .split(" ")
      .map((p) => Number(p.split(",")[1]));
    for (const y of ys) expect(y).toBeGreaterThan(15.9);
  });
});
