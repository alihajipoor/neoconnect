/** What people on one network have recently experienced on each route,
 * reduced to a tag a customer on that network can be shown.
 *
 * # What this is and is not
 *
 * Information for a person choosing a server. It is **not** an input to
 * the automatic failover order, and must not become one: commit ac56993
 * decided that, for a reason that still holds -- filtering is not
 * uniform across an ISP (two subscribers on one carrier can get
 * different answers by region and egress) and it changes day to day, so
 * an order derived from other people's experience is a guess dressed as
 * a default. The device's own history orders the ladder. A tag only
 * tells a customer, in words, what others on their network saw, and
 * leaves the choice with them.
 *
 * Which is also why the wording on the client is hedged and dated --
 * "works for most people on your network recently" -- and never "works
 * on your ISP".
 *
 * # Evidence
 *
 * Per customer and route, inside the window:
 *
 * * a **dial**: the route was tried and either carried traffic (the
 *   egress check passed) or did not. Taken from the ladder rungs a
 *   CONNECT report carries, each of which now names its route and says
 *   whether it carried. Rungs that were skipped, that failed for reasons
 *   that are not the network's (quota, an engine that would not start),
 *   or that came up without proof of traffic, carry no route and count
 *   for nothing.
 * * a **sustained session**: a SESSION report saying the tunnel kept
 *   passing its health checks for at least `SUSTAINED_SECONDS`.
 *
 * A customer is counted once per route however many times they tried,
 * and by their **latest** dial -- filtering moves, and someone whose
 * route worked this morning and failed this evening is evidence that it
 * fails now. Only reports from a signed-in customer count at all:
 * "distinct people" has to mean people, and an anonymous report cannot
 * be told from ten anonymous reports by the same person.
 */

/** How far back evidence reaches. Two days: long enough that a
 * network with a modest number of customers produces a tag at all, short
 * enough that it describes this week's filtering rather than last
 * month's. Nothing older can produce a tag, whatever its volume. */
export const WINDOW_HOURS = 48;

/** The fewest distinct customers behind any tag.
 *
 * Five, for two reasons that point the same way. Statistically, two or
 * three people agreeing is an anecdote -- and with filtering that varies
 * within one ISP, an anecdote is likely to be wrong for the next person.
 * And for privacy: a tag must never describe one identifiable person.
 * With a floor of five, "works for most people on your network" cannot
 * be read as "your colleague connected to Germany last night". Applies
 * to the numerator of a tag, not just the denominator -- three successes
 * out of five tries is not a tag.
 *
 * A constant with this note rather than a setting, for the same reason
 * the retention window is: a privacy floor that can be lowered quietly
 * tends to be. */
export const MIN_CUSTOMERS = 5;

/** How long a session has to keep carrying traffic to count as "kept
 * working". Ten minutes: past the point where a handshake that the
 * censor recognises a little late has been cut off, and short of a
 * normal session, so ordinary use reaches it. */
export const SUSTAINED_SECONDS = 600;

/** "Most" means at least this share of the customers who tried. Set
 * above a bare majority so a route that works for half of a network is
 * not presented as one that works for it. */
export const WORKS_SHARE = 0.6;

/** A route is flagged as failing when at most this share of the
 * customers who tried it got traffic through on their latest attempt. */
export const FAILING_SHARE = 0.25;

export type IspTagCode = "worksOnYourIsp" | "failingOnYourIsp";

/** The machine-readable tag sent to clients. Never prose: the client
 * words it in the customer's language. */
export interface IspTag {
  code: IspTagCode;
  /** Distinct customers behind the claim -- those it worked for, or
   * those it failed for. Always at least `MIN_CUSTOMERS`. */
  customers: number;
  /** Distinct customers on this network who tried the route. */
  outOf: number;
  windowHours: number;
}

export interface RouteIspStats {
  /** Customers with at least one dial on the route. */
  tried: number;
  /** Customers whose latest dial carried traffic. */
  carried: number;
  /** Customers with a sustained session on the route. */
  sustained: number;
  /** Customers whose latest dial carried AND who had a sustained session:
   * the people it "worked for" in the sense the tag claims. */
  worked: number;
}

/** One row of evidence, as selected from `client_attempts`. */
export interface EvidenceRow {
  customerId: string | null;
  kind: string;
  outcome: string;
  routeId: string | null;
  attemptsJson: unknown;
  sessionSeconds: number | null;
  createdAt: Date;
}

interface Dial {
  routeId: string;
  carried: boolean;
}

/** The dials a CONNECT report records, in the order they happened. */
export function dialsOf(row: EvidenceRow): Dial[] {
  const dials: Dial[] = [];
  if (Array.isArray(row.attemptsJson)) {
    for (const rung of row.attemptsJson as Array<Record<string, unknown>>) {
      if (rung && typeof rung.routeId === "string" && typeof rung.carried === "boolean") {
        dials.push({ routeId: rung.routeId, carried: rung.carried });
      }
    }
  }
  // Rungs only -- the report's own `outcome` and `routeId` are not read
  // as a dial. A SUCCESS is also what a client reports when it settled
  // on a tunnel it could not prove was carrying traffic ("unverified"),
  // and counting that as "got through" would put exactly the unproven
  // connections into a claim about what works. Clients that attach a
  // network (the only rows this reads) send an explicit rung for every
  // dial, the successful one included.
  return dials;
}

/** Reduces one network's evidence to per-route counts of customers.
 *
 * `rows` are that network's reports; anything older than the window, or
 * without a customer, is ignored here as well as in the query, so the
 * rule holds whatever the caller selected. */
export function routeStats(rows: EvidenceRow[], now: Date = new Date()): Map<string, RouteIspStats> {
  const since = now.getTime() - WINDOW_HOURS * 3_600_000;
  const latest = new Map<string, Map<string, boolean>>(); // route -> customer -> carried
  const sustained = new Map<string, Set<string>>(); // route -> customers

  const ordered = rows
    .filter((r) => r.customerId && r.createdAt.getTime() >= since)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const row of ordered) {
    const customer = row.customerId!;
    if (row.kind === "CONNECT") {
      for (const dial of dialsOf(row)) {
        let byCustomer = latest.get(dial.routeId);
        if (!byCustomer) latest.set(dial.routeId, (byCustomer = new Map<string, boolean>()));
        byCustomer.set(customer, dial.carried);
      }
    } else if (
      row.kind === "SESSION" &&
      row.outcome === "SUCCESS" &&
      row.routeId &&
      (row.sessionSeconds ?? 0) >= SUSTAINED_SECONDS
    ) {
      let set = sustained.get(row.routeId);
      if (!set) sustained.set(row.routeId, (set = new Set<string>()));
      set.add(customer);
    }
  }

  const stats = new Map<string, RouteIspStats>();
  for (const [routeId, byCustomer] of latest) {
    const kept = sustained.get(routeId) ?? new Set<string>();
    let carried = 0;
    let worked = 0;
    for (const [customer, ok] of byCustomer) {
      if (!ok) continue;
      carried += 1;
      if (kept.has(customer)) worked += 1;
    }
    stats.set(routeId, {
      tried: byCustomer.size,
      carried,
      // Only those who also dialled in the window. A session report with
      // no dial behind it (the dial aged out an hour before) says the
      // route worked once, not how it does now.
      sustained: [...kept].filter((c) => byCustomer.has(c)).length,
      worked,
    });
  }
  return stats;
}

/** The tag, if the evidence is strong enough to say anything. */
export function tagFor(stats: RouteIspStats | undefined): IspTag | null {
  if (!stats || stats.tried < MIN_CUSTOMERS) return null;
  if (stats.worked >= MIN_CUSTOMERS && stats.worked >= WORKS_SHARE * stats.tried) {
    return { code: "worksOnYourIsp", customers: stats.worked, outOf: stats.tried, windowHours: WINDOW_HOURS };
  }
  const failed = stats.tried - stats.carried;
  if (failed >= MIN_CUSTOMERS && stats.carried <= FAILING_SHARE * stats.tried) {
    return { code: "failingOnYourIsp", customers: failed, outOf: stats.tried, windowHours: WINDOW_HOURS };
  }
  return null;
}
