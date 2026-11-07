/** How much traffic each route really carried for the people on one
 * network -- the half that "stayed up" cannot say. A session can pass its
 * health checks for an hour and carry next to nothing; this is the
 * servers' own meter, so it shows whether people used the route.
 *
 * # Placing bytes on a network
 *
 * Usage is metered per credential on the node, and a usage record names
 * no network: it is placed through the customer's own reports. Each
 * customer's bytes on a route, an hour at a time, go to the network of
 * their latest report that put them on that route at or before the end
 * of that hour's usage; failing that, their latest such report in the
 * window. A customer with no such report at all is counted under
 * "unattributed" -- shown, never dropped.
 *
 * It is an approximation. A customer who changes network inside an hour
 * has that hour counted under the network they reported last, and one
 * who never reports from a network (a client too old to attach it) has
 * all of their traffic unattributed. Relay routes need nothing special:
 * the entry node meters the bytes, but the credential belongs to the
 * relay route, which is the route the customer reports.
 */

import { dialsOf, happenedAt, WINDOW_HOURS, type EvidenceRow } from "./isp-signal";

/** Upload a customer must have sent on a route, over the window, to count
 * as having used it. Download alone counts for nothing: a WireGuard peer
 * whose device has gone keeps receiving the server's handshake attempts,
 * which the node meters as download, for as long as the peer exists. One
 * megabyte is above what an idle but live tunnel's keepalives and
 * handshakes send in two days, and far below any real use. */
export const UPLOAD_FLOOR_BYTES = 1n << 20n;

/** One customer's usage on one route over (at most) one hour, as the
 * traffic query groups it. Several credentials -- one per signed-in
 * device -- are already summed into the customer's bucket. */
export interface UsageBucket {
  customerId: string;
  routeId: string;
  /** End of the latest usage period in the bucket, epoch ms. */
  until: number;
  bytesUp: bigint;
  bytesDown: bigint;
}

/** A report that can place a customer on a network. */
export type PlacementRow = EvidenceRow & { asn: number | null };

export interface RouteTraffic {
  bytesUp: bigint;
  bytesDown: bigint;
  /** Customers with any bytes on the route. */
  customers: number;
  /** Customers whose upload reached `UPLOAD_FLOOR_BYTES`. */
  withUpload: number;
  /** Median of up + down per customer with upload; null when none has. */
  typicalBytes: bigint | null;
}

export interface TrafficByNetwork {
  /** asn -> route -> traffic. */
  byAsn: Map<number, Map<string, RouteTraffic>>;
  /** route -> traffic of customers with no report placing them on it. */
  unattributed: Map<string, RouteTraffic>;
}

/** The routes a report puts its customer on: a dial that carried, where a
 * successful connect landed, and the route a session ran on. A dial that
 * failed puts nobody on a route -- no traffic came of it. */
export function placedRoutes(row: EvidenceRow): string[] {
  const routes = new Set<string>();
  if (row.kind === "CONNECT") {
    for (const dial of dialsOf(row)) if (dial.carried) routes.add(dial.routeId);
    if (row.outcome === "SUCCESS" && row.routeId) routes.add(row.routeId);
  } else if (row.kind === "SESSION" && row.routeId) {
    routes.add(row.routeId);
  }
  return [...routes];
}

const keyOf = (customerId: string, routeId: string) => `${customerId}\u0000${routeId}`;

/** Places every bucket's bytes on a network and reduces them, per network
 * and route, to totals and counts of customers. */
export function attributeTraffic(
  buckets: UsageBucket[],
  reports: PlacementRow[],
  now: Date = new Date(),
): TrafficByNetwork {
  const since = now.getTime() - WINDOW_HOURS * 3_600_000;

  // customer+route -> where they reported from, oldest first.
  const placements = new Map<string, { at: number; asn: number }[]>();
  for (const row of reports) {
    if (!row.customerId || row.asn === null || row.createdAt.getTime() < since) continue;
    const at = happenedAt(row);
    for (const routeId of placedRoutes(row)) {
      const key = keyOf(row.customerId, routeId);
      const list = placements.get(key) ?? [];
      list.push({ at, asn: row.asn });
      placements.set(key, list);
    }
  }
  for (const list of placements.values()) list.sort((a, b) => a.at - b.at);

  // (asn or none) -> route -> customer -> bytes
  const sums = new Map<number | null, Map<string, Map<string, { up: bigint; down: bigint }>>>();
  for (const bucket of buckets) {
    const asn = networkOf(placements.get(keyOf(bucket.customerId, bucket.routeId)), bucket.until);
    let byRoute = sums.get(asn);
    if (!byRoute) sums.set(asn, (byRoute = new Map<string, Map<string, { up: bigint; down: bigint }>>()));
    let byCustomer = byRoute.get(bucket.routeId);
    if (!byCustomer) byRoute.set(bucket.routeId, (byCustomer = new Map<string, { up: bigint; down: bigint }>()));
    const entry = byCustomer.get(bucket.customerId) ?? { up: 0n, down: 0n };
    entry.up += bucket.bytesUp;
    entry.down += bucket.bytesDown;
    byCustomer.set(bucket.customerId, entry);
  }

  const result: TrafficByNetwork = { byAsn: new Map(), unattributed: new Map() };
  for (const [asn, byRoute] of sums) {
    const reduced = new Map<string, RouteTraffic>();
    for (const [routeId, byCustomer] of byRoute) reduced.set(routeId, reduce(byCustomer));
    if (asn === null) result.unattributed = reduced;
    else result.byAsn.set(asn, reduced);
  }
  return result;
}

/** The network of the latest placement at or before `until`, else of the
 * latest one at all; null when there is none. */
function networkOf(list: { at: number; asn: number }[] | undefined, until: number): number | null {
  if (!list || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].at <= until) return list[i].asn;
  return list[list.length - 1].asn;
}

function reduce(byCustomer: Map<string, { up: bigint; down: bigint }>): RouteTraffic {
  let bytesUp = 0n;
  let bytesDown = 0n;
  const active: bigint[] = [];
  for (const { up, down } of byCustomer.values()) {
    bytesUp += up;
    bytesDown += down;
    if (up >= UPLOAD_FLOOR_BYTES) active.push(up + down);
  }
  return { bytesUp, bytesDown, customers: byCustomer.size, withUpload: active.length, typicalBytes: median(active) };
}

export function median(values: bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}
