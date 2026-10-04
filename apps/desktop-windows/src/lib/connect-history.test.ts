import { describe, expect, it } from "vitest";
import {
  HALF_LIFE_MS,
  KEEP_PER_KEY,
  forgetNetwork,
  recordAttempt,
  scoreFor,
  type ConnectHistory,
} from "./connect-history";

const NOW = 1_700_000_000_000;
const hours = (n: number) => n * 60 * 60 * 1000;

describe("what the device remembers", () => {
  it("knows nothing before anything has been tried", () => {
    expect(scoreFor({}, "wifi", "de-1", "WIREGUARD", NOW)).toBeNull();
  });

  /** The distinction the whole ordering rests on.
   *
   * "Never tried" and "tried, fifty-fifty" must not be the same number,
   * or an untried protocol would sort level with one that has been
   * failing all afternoon.
   */
  it("tells never-tried apart from an even split", () => {
    let h: ConnectHistory = {};
    h = recordAttempt(h, "wifi", "de-1", "WIREGUARD", true, NOW);
    h = recordAttempt(h, "wifi", "de-1", "WIREGUARD", false, NOW);

    expect(scoreFor(h, "wifi", "de-1", "WIREGUARD", NOW)).toBeCloseTo(0.5, 5);
    expect(scoreFor(h, "wifi", "de-1", "XRAY_TROJAN", NOW)).toBeNull();
  });

  it("keeps each route, protocol and network apart", () => {
    let h: ConnectHistory = {};
    h = recordAttempt(h, "wifi", "de-1", "WIREGUARD", true, NOW);

    expect(scoreFor(h, "wifi", "de-1", "WIREGUARD", NOW)).toBe(1);
    expect(scoreFor(h, "wifi", "de-1", "XRAY_TROJAN", NOW)).toBeNull();
    expect(scoreFor(h, "wifi", "nl-1", "WIREGUARD", NOW)).toBeNull();
    expect(scoreFor(h, "cellular", "de-1", "WIREGUARD", NOW)).toBeNull();
  });
});

describe("recency", () => {
  /** The property the Iranian case needs.
   *
   * Filtering changes day to day, so a protocol that worked yesterday
   * and failed an hour ago must read as failing -- not as "one all".
   */
  it("lets a recent failure outweigh older successes", () => {
    let h: ConnectHistory = {};
    for (const ago of [30, 28, 26]) {
      h = recordAttempt(h, "wifi", "de-1", "WIREGUARD", true, NOW - hours(ago));
    }
    h = recordAttempt(h, "wifi", "de-1", "WIREGUARD", false, NOW - hours(0.25));

    const score = scoreFor(h, "wifi", "de-1", "WIREGUARD", NOW)!;
    expect(score).toBeLessThan(0.5);
  });

  it("lets a recent success outweigh older failures", () => {
    let h: ConnectHistory = {};
    for (const ago of [30, 28, 26]) {
      h = recordAttempt(h, "wifi", "de-1", "XRAY_TROJAN", false, NOW - hours(ago));
    }
    h = recordAttempt(h, "wifi", "de-1", "XRAY_TROJAN", true, NOW - hours(0.25));

    expect(scoreFor(h, "wifi", "de-1", "XRAY_TROJAN", NOW)!).toBeGreaterThan(0.5);
  });

  it("halves the weight of evidence one half-life old", () => {
    let fresh: ConnectHistory = recordAttempt({}, "wifi", "de-1", "WIREGUARD", true, NOW);
    fresh = recordAttempt(fresh, "wifi", "de-1", "WIREGUARD", false, NOW - HALF_LIFE_MS);

    // One success now, one failure a half-life ago: 1 / (1 + 0.5).
    expect(scoreFor(fresh, "wifi", "de-1", "WIREGUARD", NOW)!).toBeCloseTo(2 / 3, 5);
  });

  /** Evidence old enough stops being evidence about this network. */
  it("forgets entirely once everything has decayed", () => {
    const h = recordAttempt({}, "wifi", "de-1", "WIREGUARD", true, NOW - hours(24 * 30));
    expect(scoreFor(h, "wifi", "de-1", "WIREGUARD", NOW)).toBeNull();
  });

  /** A clock that jumped backwards must not make an entry count for
   * more than a current one. */
  it("treats a future timestamp as now rather than as better than now", () => {
    const h = recordAttempt({}, "wifi", "de-1", "WIREGUARD", true, NOW + hours(5));
    expect(scoreFor(h, "wifi", "de-1", "WIREGUARD", NOW)).toBe(1);
  });
});

describe("bounds", () => {
  it("keeps only the most recent attempts per combination", () => {
    let h: ConnectHistory = {};
    for (let i = 0; i < KEEP_PER_KEY + 5; i++) {
      h = recordAttempt(h, "wifi", "de-1", "WIREGUARD", true, NOW + i);
    }
    expect(Object.values(h)[0]).toHaveLength(KEEP_PER_KEY);
  });

  /** A store on someone's machine that grows for ever is a bug with a
   * long fuse. */
  it("does not grow without limit as routes and networks multiply", () => {
    let h: ConnectHistory = {};
    for (let i = 0; i < 1200; i++) {
      h = recordAttempt(h, `net-${i}`, `route-${i}`, "WIREGUARD", true, NOW + i);
    }
    expect(Object.keys(h).length).toBeLessThanOrEqual(400);
    // The newest survived; the oldest did not.
    expect(scoreFor(h, "net-1199", "route-1199", "WIREGUARD", NOW + 1199)).toBe(1);
    expect(scoreFor(h, "net-0", "route-0", "WIREGUARD", NOW)).toBeNull();
  });
});

describe("forgetting a network", () => {
  it("drops that network and leaves the others alone", () => {
    let h: ConnectHistory = {};
    h = recordAttempt(h, "wifi", "de-1", "WIREGUARD", true, NOW);
    h = recordAttempt(h, "cellular", "de-1", "WIREGUARD", true, NOW);

    const after = forgetNetwork(h, "wifi");
    expect(scoreFor(after, "wifi", "de-1", "WIREGUARD", NOW)).toBeNull();
    expect(scoreFor(after, "cellular", "de-1", "WIREGUARD", NOW)).toBe(1);
  });
});
