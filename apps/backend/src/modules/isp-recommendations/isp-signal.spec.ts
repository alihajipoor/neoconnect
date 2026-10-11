import {
  dialsOf,
  MIN_CUSTOMERS,
  routeStats,
  SUSTAINED_SECONDS,
  tagFor,
  WINDOW_HOURS,
  type EvidenceRow,
} from "./isp-signal";

const NOW = new Date(Date.UTC(2026, 9, 5, 12, 0, 0));
const ROUTE = "route-germany";
const OTHER = "route-france";
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** A connect that worked first time: one rung, proven. */
const connected = (customerId: string | null, at = hoursAgo(2), routeId = ROUTE): EvidenceRow => ({
  customerId,
  kind: "CONNECT",
  outcome: "SUCCESS",
  routeId,
  attemptsJson: [{ protocol: "Stealth", result: "connected", routeId, carried: true }],
  sessionSeconds: null,
  createdAt: at,
});

/** A whole ladder that failed on `routeId`. */
const failed = (customerId: string, at = hoursAgo(2), routeId = ROUTE): EvidenceRow => ({
  customerId,
  kind: "CONNECT",
  outcome: "NOT_CARRYING_TRAFFIC",
  routeId: null,
  attemptsJson: [{ protocol: "Fast", result: "up but unreachable", routeId, carried: false }],
  sessionSeconds: null,
  createdAt: at,
});

const kept = (customerId: string, at = hoursAgo(1.5), seconds = SUSTAINED_SECONDS, routeId = ROUTE): EvidenceRow => ({
  customerId,
  kind: "SESSION",
  outcome: "SUCCESS",
  routeId,
  attemptsJson: null,
  sessionSeconds: seconds,
  createdAt: at,
});

/** `n` customers who connected and stayed up. */
const working = (n: number, prefix = "w") =>
  Array.from({ length: n }, (_, i) => [connected(`${prefix}${i}`), kept(`${prefix}${i}`)]).flat();

const tag = (rows: EvidenceRow[], routeId = ROUTE) => tagFor(routeStats(rows, NOW).get(routeId));

describe("per-ISP tags", () => {
  it("tags a route that worked and kept working for enough people", () => {
    expect(tag(working(MIN_CUSTOMERS))).toEqual({
      code: "worksOnYourIsp",
      customers: MIN_CUSTOMERS,
      outOf: MIN_CUSTOMERS,
      windowHours: WINDOW_HOURS,
    });
  });

  /** The floor is the whole privacy argument: no tag ever describes one
   * or two identifiable people. */
  it("says nothing below the minimum number of distinct customers", () => {
    expect(tag(working(MIN_CUSTOMERS - 1))).toBeNull();
  });

  /** Distinct people, not reports. One enthusiast reconnecting all
   * evening is one person. */
  it("counts a customer once however many times they connected", () => {
    const one = Array.from({ length: 20 }, (_, i) => [connected("same", hoursAgo(3 + i / 10)), kept("same")]).flat();
    expect(routeStats(one, NOW).get(ROUTE)).toMatchObject({ tried: 1, worked: 1 });
    expect(tag(one)).toBeNull();
  });

  /** Anonymous reports cannot be told apart, so they cannot be counted
   * as distinct people at all. */
  it("ignores reports with no customer", () => {
    const rows = Array.from({ length: 10 }, () => connected(null));
    expect(routeStats(rows, NOW).size).toBe(0);
  });

  /** Connecting is half of it. A route the censor lets through and cuts
   * off two minutes later is exactly the one people misread as working. */
  it("does not tag a route that connected but did not stay up", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => connected(`c${i}`)),
      ...Array.from({ length: 8 }, (_, i) => kept(`c${i}`, hoursAgo(1), SUSTAINED_SECONDS - 1)),
    ];
    expect(tag(rows)).toBeNull();
  });

  /** "Most" has to mean most. Five successes among twenty tries is a
   * route that fails for three in four. */
  it("needs most of the people who tried, not just enough of them", () => {
    const rows = [...working(MIN_CUSTOMERS), ...Array.from({ length: 15 }, (_, i) => failed(`f${i}`))];
    expect(tag(rows)?.code).not.toBe("worksOnYourIsp");
  });

  /** Filtering moves. What worked this morning and failed tonight is a
   * route that fails now. */
  it("goes by each customer's latest attempt", () => {
    const rows = [...working(MIN_CUSTOMERS), ...Array.from({ length: MIN_CUSTOMERS }, (_, i) => failed(`w${i}`, hoursAgo(0.5)))];
    expect(routeStats(rows, NOW).get(ROUTE)).toMatchObject({ tried: MIN_CUSTOMERS, carried: 0, worked: 0 });
    expect(tag(rows)?.code).toBe("failingOnYourIsp");
  });

  /** A failure the client could not report at the time -- the control
   * plane was unreachable -- goes out queued, on the contact the next
   * success makes, so it arrives after that success. Before: ordered by
   * arrival, it became each customer's latest dial, and a route that
   * worked for all of them was shown as failing. */
  it("goes by when an attempt happened, not when its report arrived", () => {
    const rows = Array.from({ length: MIN_CUSTOMERS }, (_, i) => [
      { ...failed(`w${i}`, hoursAgo(0.9)), occurredAt: hoursAgo(1.5) },
      connected(`w${i}`, hoursAgo(1)),
    ]).flat();
    expect(routeStats(rows, NOW).get(ROUTE)).toMatchObject({ tried: MIN_CUSTOMERS, carried: MIN_CUSTOMERS });
  });

  /** A client's clock decides the order, never more than that: a time
   * after the arrival is not believed, and the window is still the
   * arrival's. */
  it("does not let a client's clock move an attempt after its arrival, or keep one in the window", () => {
    const future = Array.from({ length: MIN_CUSTOMERS }, (_, i) => [
      connected(`w${i}`, hoursAgo(1)),
      { ...failed(`w${i}`, hoursAgo(0.5)), occurredAt: hoursAgo(-5) },
    ]).flat();
    expect(routeStats(future, NOW).get(ROUTE)).toMatchObject({ carried: 0 });
    const stale = Array.from({ length: 20 }, (_, i) => ({
      ...connected(`o${i}`, hoursAgo(WINDOW_HOURS + 1)),
      occurredAt: hoursAgo(1),
    }));
    expect(tag(stale)).toBeNull();
  });

  it("flags a route that is failing for most people on the network", () => {
    const rows = [...Array.from({ length: 6 }, (_, i) => failed(`f${i}`)), connected("lucky")];
    expect(tag(rows)).toEqual({ code: "failingOnYourIsp", customers: 6, outOf: 7, windowHours: WINDOW_HOURS });
  });

  /** The floor applies to the failing side too. */
  it("does not flag failure on fewer than the minimum", () => {
    const rows = Array.from({ length: MIN_CUSTOMERS - 1 }, (_, i) => failed(`f${i}`));
    expect(tag(rows)).toBeNull();
  });

  /** Old evidence describes a network that no longer exists. */
  it("lets nothing older than the window produce a tag", () => {
    const old = Array.from({ length: 20 }, (_, i) => [
      connected(`o${i}`, hoursAgo(WINDOW_HOURS + 1)),
      kept(`o${i}`, hoursAgo(WINDOW_HOURS + 0.5)),
    ]).flat();
    expect(tag(old)).toBeNull();
  });

  /** A session report whose dial has aged out is not evidence of now. */
  it("does not count a sustained session without a dial in the window", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => connected(`s${i}`, hoursAgo(WINDOW_HOURS + 1))),
      ...Array.from({ length: 6 }, (_, i) => kept(`s${i}`, hoursAgo(WINDOW_HOURS - 1))),
    ];
    expect(routeStats(rows, NOW).size).toBe(0);
  });

  /** One network's verdict on one route says nothing about another. */
  it("keeps routes apart", () => {
    const rows = [...working(MIN_CUSTOMERS), ...Array.from({ length: 6 }, (_, i) => failed(`f${i}`, hoursAgo(2), OTHER))];
    expect(tag(rows, ROUTE)?.code).toBe("worksOnYourIsp");
    expect(tag(rows, OTHER)?.code).toBe("failingOnYourIsp");
  });
});

describe("dialsOf", () => {
  /** A rung without a route was skipped, or refused for reasons that are
   * not the network's. It must not count against a route. */
  it("reads only rungs that name a route", () => {
    const row: EvidenceRow = {
      ...connected("c", hoursAgo(1), OTHER),
      attemptsJson: [
        { protocol: "IKEv2", result: "not available with selected apps" },
        { protocol: "Fast", result: "up but unreachable", routeId: ROUTE, carried: false },
        { protocol: "Stealth", result: "connected", routeId: OTHER, carried: true },
      ],
    };
    expect(dialsOf(row)).toEqual([
      { routeId: ROUTE, carried: false },
      { routeId: OTHER, carried: true },
    ]);
  });

  /** A SUCCESS is also what a client reports when it settled on a tunnel
   * it could not prove carried anything. Only an explicit, proven rung
   * counts as getting through. */
  it("does not read the report's own outcome as a dial", () => {
    expect(dialsOf(connected("c"))).toEqual([{ routeId: ROUTE, carried: true }]);
    expect(
      dialsOf({ ...connected("c"), attemptsJson: [{ protocol: "Fast", result: "connected" }] }),
    ).toEqual([]);
    expect(dialsOf({ ...connected("c"), attemptsJson: null })).toEqual([]);
  });
});
