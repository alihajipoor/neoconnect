import { WINDOW_HOURS } from "./isp-signal";
import { attributeTraffic, median, placedRoutes, UPLOAD_FLOOR_BYTES, type PlacementRow, type UsageBucket } from "./isp-traffic";

const HOUR = 3_600_000;
const now = Date.UTC(2026, 10, 7, 12, 0, 0);
const MB = 1n << 20n;
const A = 64500;
const B = 64501;

/** A connect from `asn` whose ladder carried on `routeId`. */
function connect(customerId: string, asn: number, routeId: string, at: number, carried = true): PlacementRow {
  return {
    customerId,
    asn,
    kind: "CONNECT",
    outcome: carried ? "SUCCESS" : "FAILURE",
    routeId: carried ? routeId : null,
    attemptsJson: [{ protocol: "Fast", result: carried ? "connected" : "failed", routeId, carried }],
    sessionSeconds: null,
    createdAt: new Date(at),
    occurredAt: new Date(at),
  };
}

function bucket(customerId: string, routeId: string, until: number, up: bigint, down: bigint): UsageBucket {
  return { customerId, routeId, until, bytesUp: up, bytesDown: down };
}

describe("attributeTraffic", () => {
  /** The rule the panel states: each hour's bytes go to the network the
   * customer last reported from on that route by then. */
  it("follows a customer who switches networks mid-window", () => {
    const reports = [connect("c1", A, "r1", now - 10 * HOUR), connect("c1", B, "r1", now - 4 * HOUR)];
    const buckets = [
      bucket("c1", "r1", now - 9 * HOUR, 5n * MB, 50n * MB), // on A by then
      bucket("c1", "r1", now - 5 * HOUR, 3n * MB, 30n * MB), // still A: B came later
      bucket("c1", "r1", now - 2 * HOUR, 2n * MB, 20n * MB), // on B
    ];
    const { byAsn, unattributed } = attributeTraffic(buckets, reports, new Date(now));

    expect(byAsn.get(A)?.get("r1")).toEqual({
      bytesUp: 8n * MB,
      bytesDown: 80n * MB,
      customers: 1,
      withUpload: 1,
      typicalBytes: 88n * MB,
    });
    expect(byAsn.get(B)?.get("r1")).toMatchObject({ bytesUp: 2n * MB, bytesDown: 20n * MB, customers: 1, withUpload: 1 });
    expect(unattributed.size).toBe(0);
  });

  /** Usage from before the customer's first report in the window still
   * belongs to someone: their latest report there. */
  it("falls back to the latest report when none precedes the usage", () => {
    const reports = [connect("c1", A, "r1", now - 6 * HOUR), connect("c1", B, "r1", now - 3 * HOUR)];
    const { byAsn } = attributeTraffic([bucket("c1", "r1", now - 20 * HOUR, 2n * MB, 2n * MB)], reports, new Date(now));
    expect(byAsn.get(A)).toBeUndefined();
    expect(byAsn.get(B)?.get("r1")?.bytesUp).toBe(2n * MB);
  });

  /** One credential per signed-in device: a phone and a laptop on one
   * route are one customer, and their upload is added up before the
   * floor is applied. */
  it("counts a customer once across per-device credentials", () => {
    const half = UPLOAD_FLOOR_BYTES / 2n + 1n;
    const reports = [connect("c1", A, "r1", now - 10 * HOUR)];
    const buckets = [
      bucket("c1", "r1", now - 2 * HOUR, half, 10n * MB), // phone
      bucket("c1", "r1", now - 2 * HOUR, half, 10n * MB), // laptop, same hour
    ];
    const traffic = attributeTraffic(buckets, reports, new Date(now)).byAsn.get(A)?.get("r1");
    expect(traffic).toEqual({
      bytesUp: 2n * half,
      bytesDown: 20n * MB,
      customers: 1,
      withUpload: 1,
      typicalBytes: 2n * half + 20n * MB,
    });
  });

  /** Download with no upload is what a WireGuard peer whose device has
   * gone looks like: metered, but nobody using it. */
  it("never counts a download-only customer as having upload", () => {
    const reports = [connect("c1", A, "r1", now - 10 * HOUR), connect("ghost", A, "r1", now - 10 * HOUR)];
    const buckets = [
      bucket("c1", "r1", now - HOUR, 4n * MB, 40n * MB),
      bucket("ghost", "r1", now - HOUR, 0n, 900n * MB),
      bucket("ghost", "r1", now - 2 * HOUR, UPLOAD_FLOOR_BYTES - 1n, 900n * MB),
    ];
    const traffic = attributeTraffic(buckets, reports, new Date(now)).byAsn.get(A)?.get("r1");
    expect(traffic).toMatchObject({ customers: 2, withUpload: 1, typicalBytes: 44n * MB });
    // Its bytes are still in the total -- it is what the node metered.
    expect(traffic?.bytesDown).toBe(1840n * MB);
  });

  it("keeps traffic it cannot place on a network as unattributed", () => {
    const reports = [
      connect("c1", A, "r2", now - 10 * HOUR), // a report, but on another route
      connect("c2", A, "r1", now - 10 * HOUR, false), // a failed dial puts nobody on r1
      { ...connect("c3", A, "r1", now - 10 * HOUR), asn: null }, // no network attached
      connect("c4", A, "r1", now - (WINDOW_HOURS + 1) * HOUR), // aged out
    ];
    const buckets = ["c1", "c2", "c3", "c4", "c5"].map((c) => bucket(c, "r1", now - HOUR, 2n * MB, 2n * MB));
    const { byAsn, unattributed } = attributeTraffic(buckets, reports, new Date(now));

    expect(byAsn.size).toBe(0);
    expect(unattributed.get("r1")).toEqual({
      bytesUp: 10n * MB,
      bytesDown: 10n * MB,
      customers: 5,
      withUpload: 5,
      typicalBytes: 4n * MB,
    });
  });

  it("places by a session report too, and by a client's own time", () => {
    const session: PlacementRow = {
      customerId: "c1",
      asn: B,
      kind: "SESSION",
      outcome: "SUCCESS",
      routeId: "r1",
      attemptsJson: null,
      sessionSeconds: 900,
      // Arrived late, but happened before the usage.
      createdAt: new Date(now - HOUR),
      occurredAt: new Date(now - 5 * HOUR),
    };
    const reports = [connect("c1", A, "r1", now - 10 * HOUR), session];
    const { byAsn } = attributeTraffic([bucket("c1", "r1", now - 4 * HOUR, 2n * MB, 0n)], reports, new Date(now));
    expect(byAsn.get(B)?.get("r1")?.customers).toBe(1);
    expect(byAsn.get(A)).toBeUndefined();
  });
});

describe("placedRoutes", () => {
  it("names carried rungs and the landed route, never a failed dial", () => {
    const row: PlacementRow = {
      ...connect("c1", A, "r1", now),
      attemptsJson: [
        { routeId: "r0", carried: false },
        { routeId: "r1", carried: true },
      ],
    };
    expect(placedRoutes(row).sort()).toEqual(["r1"]);
  });
});

describe("median", () => {
  it("takes the middle, or the mean of the middle two", () => {
    expect(median([])).toBeNull();
    expect(median([5n, 1n, 3n])).toBe(3n);
    expect(median([4n, 1n, 10n, 2n])).toBe(3n);
  });
});
