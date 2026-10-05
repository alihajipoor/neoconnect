import { Injectable } from "@nestjs/common";
import { ClientAttemptKind } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import { routeStats, tagFor, WINDOW_HOURS, type EvidenceRow, type IspTag, type RouteIspStats } from "./isp-signal";

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
} as const;

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
   * a tag -- with the tag a customer would see alongside. */
  async adminSummary(now = Date.now()) {
    const rows = await this.prisma.clientAttempt.findMany({
      where: {
        asn: { not: null },
        customerId: { not: null },
        kind: { in: [ClientAttemptKind.CONNECT, ClientAttemptKind.SESSION] },
        createdAt: { gte: new Date(now - WINDOW_HOURS * 3_600_000) },
      },
      select: { ...EVIDENCE_SELECT, asn: true },
      orderBy: { createdAt: "desc" },
      take: ADMIN_MAX_ROWS,
    });

    const byAsn = new Map<number, EvidenceRow[]>();
    for (const row of rows) {
      const list = byAsn.get(row.asn!) ?? [];
      list.push(row);
      byAsn.set(row.asn!, list);
    }

    const perAsn = [...byAsn].map(([asn, evidence]) => ({ asn, stats: routeStats(evidence, new Date(now)) }));
    const routeIds = [...new Set(perAsn.flatMap((a) => [...a.stats.keys()]))];
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

    const networks = perAsn.map(({ asn, stats }) => ({
      asn,
      org: this.identity.orgOf(asn),
      routes: [...stats].map(([routeId, s]: [string, RouteIspStats]) => {
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
          ...s,
          tag: tagFor(s),
        };
      }),
    }));
    // Busiest networks first: those are the ones whose tags matter.
    networks.sort(
      (a, b) =>
        Math.max(0, ...b.routes.map((r) => r.tried)) - Math.max(0, ...a.routes.map((r) => r.tried)),
    );

    return { windowHours: WINDOW_HOURS, truncated: rows.length >= ADMIN_MAX_ROWS, networks };
  }
}
