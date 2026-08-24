import { UPLINK_FRESH_MS, uplinkIsFresh } from "./routes.service";

/**
 * When a relay route is allowed to call itself up.
 *
 * Until 2026-08-23 it always was: the picker reported the ENTRY node's
 * heartbeat, which says nothing about the exit. ir1 was up and
 * heartbeating and holding every outbound and rule while both exits had
 * lost the uplink credential, so thirteen dead routes read ONLINE for
 * days. The product rule this breaks is the same one a false "Connected"
 * breaks, and customers in Iran act on it.
 */
describe("relay uplink freshness", () => {
  const now = Date.UTC(2026, 7, 23, 12, 0, 0);

  it("treats never-asserted as unhealthy, not as unknown", () => {
    // Every pre-existing route is null here. Reading null as "probably
    // fine" would rebuild the exact bug: a route reporting up because
    // nothing has checked it.
    expect(uplinkIsFresh(null, now)).toBe(false);
  });

  it("is healthy within the window", () => {
    expect(uplinkIsFresh(new Date(now - 30_000), now)).toBe(true);
  });

  it("is unhealthy once three sweeps have been missed", () => {
    expect(uplinkIsFresh(new Date(now - UPLINK_FRESH_MS - 1), now)).toBe(false);
  });

  it("holds at the boundary rather than flapping on one slow ack", () => {
    expect(uplinkIsFresh(new Date(now - UPLINK_FRESH_MS), now)).toBe(true);
  });

  it("does not report a days-old assert as current", () => {
    // The measured case: the last successful assert on the France routes
    // predated france-1's 2026-08-19 Xray restart.
    expect(uplinkIsFresh(new Date(now - 4 * 24 * 3600_000), now)).toBe(false);
  });
});
