import { Injectable } from "@nestjs/common";
import { ClientAttemptKind, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import { routeStats, tagFor, WINDOW_HOURS, type EvidenceRow, type IspTag, type RouteIspStats } from "./isp-signal";
import { attributeTraffic, type RouteTraffic, type UsageBucket } from "./isp-traffic";

/** How long one network's tags are reused. The window is two days, so a
 * tag that is ten minutes stale is no less true; and the route list is
 * fetched on every dashboard load and every picker open. */
const CACHE_MS = 10 * 60_000;
/** Bounds the cache. Far more networks than the customer base spans, so
 * in practice it never fills; if it does, it starts over. */
const CACHE_MAX = 5_000;
/** Bounds the admin view's scan. Two days of reports from the whole
 * customer base is a few thousand rows today. */
const ADMIN_MAX_ROWS = 50_000;

/** Columns the aggregation reads -- named, never the whole row, which
 * carries an IP address the aggregation has no business touching. */
const EVIDENCE_SELECT = {
  customerId: true,
  kind: true,
  outcome: true,
  routeId: true,
  attemptsJson: true,
  sessionSeconds: true,
  createdAt: true,
  occurredAt: true,
} as const;

/** One row of the traffic query: a customer's usage on one route (null
 * when the credential has since been removed) over one hour. */
interface RawUsageBucket {
  customerId: string;
  routeId: string | null;
  until: bigint | number;
  up: string | null;
  down: string | null;
}

const NO_STATS: RouteIspStats = { tried: 0, carried: 0, sustained: 0, worked: 0 };
const NO_TRAFFIC: RouteTraffic = { bytesUp: 0n, bytesDown: 0n, customers: 0, withUpload: 0, typicalBytes: null };

/** Byte counts as decimal strings: two days of a busy route can pass what
 * a JSON number holds exactly. */
function trafficJson(t: RouteTraffic) {
  return {
    bytesUp: t.bytesUp.toString(),
    bytesDown: t.bytesDown.toString(),
    customers: t.customers,
    withUpload: t.withUpload,
    typicalBytes: t.typicalBytes === null ? null : t.typicalBytes.toString(),
  };
}

@Injectable()
export class IspRecommendationsService {
  private readonly cache = new Map<number, { at: number; tags: Map<string, IspTag> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: NetworkIdentityService,
  ) {}

  /** Which network to describe for a route-list request.
   *
   * The client's attestation first: it was taken before the tunnel came
   * up, and the route list is often fetched through the tunnel, where
   * the request's own address is a node's. Failing that, the request's
   * address -- which `identify` refuses when it is one of ours, so a
   * request through the tunnel with no attestation gets no tags rather
   * than the node's data centre's. */
  async networkFor(attestation: string | undefined, requestIp: string | undefined): Promise<number | null> {
    const attested = this.identity.verify(attestation);
    if (attested !== null) return attested;
    return (await this.identity.identify(requestIp))?.asn ?? null;
  }

  /** Tags for every route with enough evidence on `asn`. */
  async tagsFor(asn: number | null, now = Date.now()): Promise<Map<string, IspTag>> {
    if (asn === null) return new Map();
    const hit = this.cache.get(asn);
    if (hit && now - hit.at < CACHE_MS) return hit.tags;

    const rows = await this.prisma.clientAttempt.findMany({
      where: {
        asn,
        customerId: { not: null },
        kind: { in: [ClientAttemptKind.CONNECT, ClientAttemptKind.SESSION] },
        createdAt: { gte: new Date(now - WINDOW_HOURS * 3_600_000) },
      },
      select: EVIDENCE_SELECT,
    });
    const tags = new Map<string, IspTag>();
    for (const [routeId, stats] of routeStats(rows, new Date(now))) {
      const tag = tagFor(stats);
      if (tag) tags.set(routeId, tag);
    }

    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(asn, { at: now, tags });
    return tags;
  }

  /** Every network and route with any evidence in the window, for the
   * panel. Below-threshold rows are included -- an operator needs to see
   * "three people on Irancell failed on Germany" well before it becomes
   * a tag -- with the tag a customer would see alongside.
   *
   * Each row also carries the traffic the servers metered for those
   * customers on that route (see isp-traffic.ts for how bytes are placed
   * on a network), so "stayed up" can be read against whether anyone
   * actually used it. Traffic that cannot be placed on a network, or no
   * longer on a route, is returned separately rather than dropped. */
  async adminSummary(now = Date.now()) {
    const since = new Date(now - WINDOW_HOURS * 3_600_000);
    const [rows, usage] = await Promise.all([
      this.prisma.clientAttempt.findMany({
        where: {
          asn: { not: null },
          customerId: { not: null },
          kind: { in: [ClientAttemptKind.CONNECT, ClientAttemptKind.SESSION] },
          createdAt: { gte: since },
        },
        select: { ...EVIDENCE_SELECT, asn: true },
        orderBy: { createdAt: "desc" },
        take: ADMIN_MAX_ROWS,
      }),
      this.usageBuckets(since),
    ]);

    const byAsn = new Map<number, EvidenceRow[]>();
    for (const row of rows) {
      const list = byAsn.get(row.asn!) ?? [];
      list.push(row);
      byAsn.set(row.asn!, list);
    }
    const traffic = attributeTraffic(usage.buckets, rows, new Date(now));

    const asns = new Set([...byAsn.keys(), ...traffic.byAsn.keys()]);
    const perAsn = [...asns].map((asn) => ({
      asn,
      stats: routeStats(byAsn.get(asn) ?? [], new Date(now)),
      traffic: traffic.byAsn.get(asn) ?? new Map<string, RouteTraffic>(),
    }));
    const routeIds = [
      ...new Set([
        ...perAsn.flatMap((a) => [...a.stats.keys(), ...a.traffic.keys()]),
        ...traffic.unattributed.keys(),
      ]),
    ];
    const routes = await this.prisma.route.findMany({
      where: { id: { in: routeIds } },
      select: {
        id: true,
        name: true,
        exitProtocolConfigId: true,
        entryProtocolConfig: { select: { protocol: true, transport: true, node: { select: { name: true } } } },
      },
    });
    const routeById = new Map(routes.map((r) => [r.id, r]));
    const describe = (routeId: string) => {
      const route = routeById.get(routeId);
      return {
        routeId,
        // A route deleted inside the window still has evidence; it is
        // shown by id rather than dropped.
        routeName: route?.name ?? null,
        nodeName: route?.entryProtocolConfig.node.name ?? null,
        protocol: route?.entryProtocolConfig.protocol ?? null,
        transport: route?.entryProtocolConfig.transport ?? null,
        isRelay: route ? route.exitProtocolConfigId !== null : null,
      };
    };

    const networks = perAsn.map(({ asn, stats, traffic: carried }) => ({
      asn,
      org: this.identity.orgOf(asn),
      // A route can have traffic here and no dial: the customer's only
      // report on it from this network was a session, or a dial that aged
      // out. It is shown with nobody counted as having tried it.
      routes: [...new Set([...stats.keys(), ...carried.keys()])].map((routeId) => {
        const s = stats.get(routeId) ?? NO_STATS;
        return {
          ...describe(routeId),
          ...s,
          tag: tagFor(s),
          traffic: trafficJson(carried.get(routeId) ?? NO_TRAFFIC),
        };
      }),
    }));
    // Busiest networks first: those are the ones whose tags matter.
    networks.sort(
      (a, b) =>
        Math.max(0, ...b.routes.map((r) => r.tried)) - Math.max(0, ...a.routes.map((r) => r.tried)),
    );

    const unattributed = [...traffic.unattributed]
      .sort(([, a], [, b]) => {
        const d = b.bytesUp + b.bytesDown - (a.bytesUp + a.bytesDown);
        return d > 0n ? 1 : d < 0n ? -1 : 0;
      })
      .map(([routeId, t]) => ({ ...describe(routeId), traffic: trafficJson(t) }));

    return {
      windowHours: WINDOW_HOURS,
      truncated: rows.length >= ADMIN_MAX_ROWS,
      networks,
      unattributed,
      withoutRoute: usage.withoutRoute,
    };
  }

  /** Every customer's metered usage in the window, summed per route and
   * hour across all of their credentials -- one per signed-in device, and
   * the subscription's shared one -- so a customer is one customer however
   * many devices they use. Grouped in the database: the table holds a row
   * per credential per agent report, far too many to read.
   *
   * Usage whose credential has since been removed (switching servers
   * deletes it; the record outlives it with no route) is returned as a
   * total, since it can be placed on no route.
   *
   * The node list in the filter makes it an index range scan per node on
   * (nodeId, reportedAt), as CustomerActivityService.liveRows does, rather
   * than a scan of the whole table. reportedAt is TIMESTAMP(3) holding
   * UTC; the bound is pinned to UTC as there, and the epoch of a plain
   * timestamp is the UTC one. */
  private async usageBuckets(since: Date): Promise<{
    buckets: UsageBucket[];
    withoutRoute: { bytesUp: string; bytesDown: string; customers: number };
  }> {
    const nodes = await this.prisma.node.findMany({ select: { id: true } });
    const rows =
      nodes.length === 0
        ? []
        : await this.prisma.$queryRaw<RawUsageBucket[]>`
            SELECT s."customerId" AS "customerId",
                   p."routeId" AS "routeId",
                   (EXTRACT(EPOCH FROM MAX(u."periodEnd")) * 1000)::bigint AS "until",
                   SUM(u."bytesUp")::text AS "up",
                   SUM(u."bytesDown")::text AS "down"
            FROM "usage_records" u
            JOIN "subscriptions" s ON s."id" = u."subscriptionId"
            LEFT JOIN "protocol_users" p ON p."id" = u."protocolUserId"
            WHERE u."nodeId" IN (${Prisma.join(nodes.map((n) => n.id))})
              AND u."reportedAt" >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
            GROUP BY s."customerId", p."routeId", FLOOR(EXTRACT(EPOCH FROM u."reportedAt") / 3600)`;

    const buckets: UsageBucket[] = [];
    let upWithout = 0n;
    let downWithout = 0n;
    const customersWithout = new Set<string>();
    for (const row of rows) {
      const bytesUp = BigInt(row.up ?? "0");
      const bytesDown = BigInt(row.down ?? "0");
      if (row.routeId === null) {
        upWithout += bytesUp;
        downWithout += bytesDown;
        customersWithout.add(row.customerId);
      } else {
        buckets.push({ customerId: row.customerId, routeId: row.routeId, until: Number(row.until), bytesUp, bytesDown });
      }
    }
    return {
      buckets,
      withoutRoute: {
        bytesUp: upWithout.toString(),
        bytesDown: downWithout.toString(),
        customers: customersWithout.size,
      },
    };
  }
}
