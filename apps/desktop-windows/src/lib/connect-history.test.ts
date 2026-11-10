import { describe, expect, it } from "vitest";
import {
  FAILED_LAST_MS,
  HALF_LIFE_MS,
  KEEP_PER_KEY,
  failedLately,
  forgetNetwork,
  latestAttempt,
  recordAttempt,
  recordDead,
  recordSpeed,
  scoreFor,
  workedLately,
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

describe("latestAttempt", () => {
  it("is null with nothing recorded for the combination", () => {
    expect(latestAttempt({}, "wifi", "de-1", "WIREGUARD")).toBeNull();
  });

  it("returns the newest attempt by its stamp, not by its position", () => {
    const h: ConnectHistory = {
      "wifi|de-1|WIREGUARD": [
        { at: NOW - hours(1), ok: false },
        { at: NOW - hours(3), ok: true },
      ],
    };
    expect(latestAttempt(h, "wifi", "de-1", "WIREGUARD")).toEqual({ at: NOW - hours(1), ok: false });
    expect(latestAttempt(h, "cellular", "de-1", "WIREGUARD")).toBeNull();
  });
});

describe("a rung that has only failed here lately", () => {
  const NET = "home";
  const failed = (h: ConnectHistory, now = NOW) => failedLately(h, NET, "de-1", "XRAY_VLESS_TLS", now);

  it("is one that came up and carried nothing, or did not connect, every time it was tried in the window", () => {
    let h = recordDead({}, NET, "de-1", "XRAY_VLESS_TLS", NOW - hours(2));
    expect(failed(h)).toBe(true);
    h = recordDead(h, NET, "de-1", "XRAY_VLESS_TLS", NOW - hours(1));
    expect(failed(h)).toBe(true);
    // A failure like any other to the score.
    expect(scoreFor(h, NET, "de-1", "XRAY_VLESS_TLS", NOW)).toBe(0);
    // Nothing is known of what was never tried, or of another network.
    expect(failedLately(h, NET, "de-1", "XRAY_VLESS_REALITY", NOW)).toBe(false);
    expect(failedLately(h, "office", "de-1", "XRAY_VLESS_TLS", NOW)).toBe(false);
    expect(failedLately({}, NET, "de-1", "XRAY_VLESS_TLS", NOW)).toBe(false);
  });

  it("is forgotten after a few hours: blocks change", () => {
    const h = recordDead({}, NET, "de-1", "XRAY_VLESS_TLS", NOW);
    expect(failed(h, NOW + FAILED_LAST_MS)).toBe(true);
    expect(failed(h, NOW + FAILED_LAST_MS + 1)).toBe(false);
    expect(FAILED_LAST_MS).toBe(hours(6));
  });

  it("is not one that also worked in the window, whichever came last", () => {
    let h = recordAttempt({}, NET, "de-1", "XRAY_VLESS_TLS", true, NOW - hours(2));
    h = recordDead(h, NET, "de-1", "XRAY_VLESS_TLS", NOW - hours(1));
    expect(failed(h)).toBe(false);
    // The success out of the window, the failure in it.
    expect(failed(h, NOW + hours(4) + 1)).toBe(true);
  });

  it("is not one that was only slow, nor a landing nothing could confirm", () => {
    // Slow: a failure with a speed. It carried data.
    let slow = recordAttempt({}, NET, "de-1", "XRAY_VLESS_TLS", false, NOW - hours(1));
    slow = recordSpeed(slow, NET, "de-1", "XRAY_VLESS_TLS", 0);
    expect(failed(slow)).toBe(false);
    // Unconfirmed: a failure to the score, and not known to have failed.
    const unconfirmed = recordAttempt({}, NET, "de-1", "XRAY_VLESS_TLS", false, NOW - hours(1));
    expect(failed(unconfirmed)).toBe(false);
    // And one of either beside a dead try keeps the rung off the list.
    expect(failed(recordDead(slow, NET, "de-1", "XRAY_VLESS_TLS", NOW))).toBe(false);
  });

  it("keeps the mark when a speed is stamped on a later attempt", () => {
    let h = recordDead({}, NET, "de-1", "XRAY_VLESS_TLS", NOW - hours(1));
    h = recordAttempt(h, NET, "de-1", "XRAY_VLESS_TLS", true, NOW);
    h = recordSpeed(h, NET, "de-1", "XRAY_VLESS_TLS", 900);
    expect(h[`${NET}|de-1|XRAY_VLESS_TLS`]).toEqual([
      { at: NOW - hours(1), ok: false, dead: true },
      { at: NOW, ok: true, kbps: 900 },
    ]);
  });
});

describe("a rung that carried traffic here lately", () => {
  it("is any verified attempt in the last day, however the tries since went", () => {
    let h = recordAttempt({}, "home", "de-1", "SHADOWSOCKS", true, NOW - hours(20));
    // Slow twice since: under an untried rung by the score, and still the
    // likelier to move.
    h = recordAttempt(h, "home", "de-1", "SHADOWSOCKS", false, NOW - hours(2));
    h = recordAttempt(h, "home", "de-1", "SHADOWSOCKS", false, NOW - hours(1));
    expect(scoreFor(h, "home", "de-1", "SHADOWSOCKS", NOW)).toBeLessThan(0.5);
    expect(workedLately(h, "home", "de-1", "SHADOWSOCKS", NOW)).toBe(true);
    expect(workedLately(h, "home", "de-1", "SHADOWSOCKS", NOW + hours(5))).toBe(false);
    expect(workedLately(h, "office", "de-1", "SHADOWSOCKS", NOW)).toBe(false);
    expect(workedLately(recordDead({}, "home", "de-1", "SHADOWSOCKS", NOW), "home", "de-1", "SHADOWSOCKS", NOW)).toBe(false);
  });
});
