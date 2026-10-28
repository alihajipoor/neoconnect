import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isIP } from "node:net";
import { PrismaService } from "../../prisma/prisma.service";
import { AsnLookupService } from "../network-identity/asn-lookup.service";
import { normaliseIp } from "../network-identity/asn-table";
import type { DestinationBatchMessage, DestinationCountMessage } from "../agent-gateway/agent-messages";

/** How long a row is kept, and the widest window GET /customers/:id/sites
 * will read.
 *
 * Seven days because that is what the privacy page says, and because the
 * question this answers -- "what was this customer's connection doing
 * when it went wrong" -- is about the last few days, not a history. A
 * constant with this note attached rather than a setting, for the same
 * reason as the attempt log's: a retention window that can be raised
 * quietly tends to be. */
export const SITE_VISIT_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

/** The most destinations one batch may write.
 *
 * The agent caps distinct destinations per window on its own side and
 * says how many lines it left out (`dropped`). This is the backend's own
 * bound, so a misbehaving or very old agent cannot turn one message into
 * an unbounded insert. Anything past it is counted in the log line, not
 * silently lost. */
export const MAX_DESTINATIONS_PER_BATCH = 5_000;

/** The most destinations one batch may write for any one customer.
 *
 * The agent already holds each credential to a share of the window
 * (accesslog.DefaultMaxPerUser, 500), so that one account spraying
 * addresses cannot fill it for the whole node. This is the same bound on
 * the backend's side, per customer rather than per credential: a
 * customer's devices each have a credential, and two of them at their
 * cap fit. Past it, the rest is counted in the log line. Without it an
 * agent that did not cap -- an old one, a broken one -- would let one
 * customer write up to MAX_DESTINATIONS_PER_BATCH rows a minute per node
 * and keep them for a week. */
export const MAX_DESTINATIONS_PER_CUSTOMER_PER_BATCH = 1_000;

/** Rows per INSERT. Eleven columns each, well under Postgres's 65k
 * parameter limit, and small enough that one bad row only costs its own
 * chunk. */
const INSERT_CHUNK = 1_000;

/** How long the answer to "whose credential is this" is remembered.
 *
 * A batch arrives from every node every minute or so, naming mostly the
 * same people as the last one; without a cache each would cost a query.
 * Five minutes is short against how long a credential lives. An unknown
 * credential is remembered for less, so a credential created moments
 * before its first batch is not shut out for long -- in practice the row
 * exists before the node is told to create the user, so that should not
 * happen at all. */
const OWNER_TTL_MS = 5 * 60_000;
const UNKNOWN_OWNER_TTL_MS = 60_000;
/** A bound on the cache, not a size anyone should reach: when it is
 * exceeded it is simply emptied and refilled. */
const MAX_CACHED_OWNERS = 50_000;

/** A node's clock may run ahead. A last-seen time later than this past
 * the server's own is taken as "now" instead. */
const FUTURE_SKEW_MS = 5 * 60_000;

/** A DNS name is at most 253 characters, an IPv6 literal 45 even with
 * brackets and a zone. A longer host is not one Xray logged. */
const MAX_HOST_LENGTH = 253;
const MAX_TAG_LENGTH = 64;
const MAX_INT32 = 2_147_483_647;

const DEFAULT_TAKE = 200;
const MAX_TAKE = 1_000;
const MAX_QUERY_LENGTH = 100;

/** What GET /customers/:id/sites says about its own coverage, for the
 * panel to show beside the list.
 *
 * Said because the list is easy to over-read. A destination appears only
 * when the server's Xray access log saw it, which is the Stealth family
 * and Shadowsocks, on servers whose log is switched on. WireGuard ("Fast"),
 * OpenVPN ("Compatible") and IKEv2 ("Built-in") never pass through that
 * log, so a customer on one of those has no history here at all, and an
 * empty list does not mean they went nowhere. And the servers do not read
 * the name a connection asked for -- no sniffing -- so most destinations
 * are addresses, which the owner column only partly names. */
export const SITE_COVERAGE =
  "Only connections our servers' connection log records appear here: the Stealth family and Shadowsocks, on servers " +
  "whose log is on. Fast, Compatible and Built-in connections are not recorded, so an empty list does not mean the " +
  "customer went nowhere. Destinations are mostly addresses, because the servers do not read site names.";

interface Owner {
  customerId: string;
  protocol: string;
}

export interface SiteRow {
  host: string;
  port: number;
  network: string;
  /** The network that announces the address, when the host is an address
   * and the table knows it; null for a name, or an address nobody
   * announces. */
  owner: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  servers: string[];
  protocols: string[];
}

export interface SitesView {
  retentionDays: number;
  coverage: string;
  /** Distinct destinations matching, before `take`. */
  total: number;
  sites: SiteRow[];
}

/** One destination as the grouping query in sites() returns it. */
interface SiteGroupRow {
  host: string;
  port: number;
  network: string;
  /** SUM over an INTEGER column: BIGINT, which the driver hands back as a
   * bigint. */
  count: bigint | number;
  firstSeen: Date | null;
  lastSeen: Date;
  nodeIds: string[] | null;
  protocols: string[] | null;
}

export interface SitesQuery {
  days?: string | number;
  q?: string;
  take?: string | number;
}

/** Where each customer's connections went, for the last seven days.
 *
 * Written from DestinationBatch messages: the agent counts its node's
 * Xray access log per user and destination and sends the counts once a
 * window. Each count names a provisioned user by its external id, which
 * is mapped here to the customer who owns it ON THAT NODE -- the same id
 * means nothing on another node -- and anything that maps to no customer
 * is dropped: a relay's uplink credential (route:<id>), whose traffic is
 * every relay customer's at once, or a credential deleted since.
 *
 * Read by the owner only (GET /customers/:id/sites, SUPERADMIN, logged in
 * the admin audit), and pruned past seven days by the sweeps queue. */
@Injectable()
export class SiteVisitsService {
  private readonly logger = new Logger(SiteVisitsService.name);
  private readonly owners = new Map<string, { owner: Owner | null; until: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly asn: AsnLookupService,
  ) {}

  /** Stores one batch from `nodeId`, the node the stream authenticated
   * as. Returns the number of rows written.
   *
   * Never throws. It runs on the node's control stream, where an error
   * closes the stream -- and that stream is also what provisions the
   * node's users. Losing a batch of history is strictly better than
   * dropping a node's connection to the control plane over it. */
  async record(nodeId: string, batch: DestinationBatchMessage | undefined, now: number = Date.now()): Promise<number> {
    try {
      return await this.write(nodeId, batch, now);
    } catch (err) {
      this.logger.warn(`Site history from node ${nodeId} not stored: ${(err as Error).message}`);
      return 0;
    }
  }

  private async write(nodeId: string, batch: DestinationBatchMessage | undefined, now: number): Promise<number> {
    const all = batch?.destinations ?? [];
    if (all.length === 0) return 0;
    const destinations = all.slice(0, MAX_DESTINATIONS_PER_BATCH);
    if (all.length > destinations.length) {
      this.logger.warn(
        `Node ${nodeId} sent ${all.length} destinations in one batch; kept the first ${destinations.length}`,
      );
    }

    const windowStart = secondsToDate(batch?.windowStart) ?? new Date(now);
    const windowEnd = secondsToDate(batch?.windowEnd) ?? new Date(now);
    const owners = await this.ownersOf(
      nodeId,
      [...new Set(destinations.map((d) => d.externalUserId).filter((id) => typeof id === "string" && id))],
      now,
    );

    const rows: Prisma.SiteVisitCreateManyInput[] = [];
    const perCustomer = new Map<string, number>();
    let unowned = 0;
    let overShare = 0;
    for (const destination of destinations) {
      const owner = owners.get(destination.externalUserId);
      if (!owner) {
        unowned++;
        continue;
      }
      const row = rowOf(nodeId, owner, destination, windowStart, windowEnd, now);
      if (!row) continue;
      const held = perCustomer.get(owner.customerId) ?? 0;
      if (held >= MAX_DESTINATIONS_PER_CUSTOMER_PER_BATCH) {
        overShare++;
        continue;
      }
      perCustomer.set(owner.customerId, held + 1);
      rows.push(row);
    }

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await this.prisma.siteVisit.createMany({ data: rows.slice(i, i + INSERT_CHUNK) });
    }
    if (batch?.dropped) {
      this.logger.log(`Node ${nodeId} left ${batch.dropped} connection(s) uncounted in one window: its cap was reached`);
    }
    if (overShare > 0) {
      this.logger.warn(
        `Node ${nodeId}: ${overShare} destination(s) not stored, past ${MAX_DESTINATIONS_PER_CUSTOMER_PER_BATCH} for one customer in one batch`,
      );
    }
    if (unowned > 0) {
      this.logger.debug(`Node ${nodeId}: ${unowned} destination(s) named no customer (relay uplink or deleted)`);
    }
    return rows.length;
  }

  /** The customer and protocol behind each external id on `nodeId`, from
   * the cache where it is fresh. Ids with no ProtocolUser on that node
   * are absent from the result. */
  private async ownersOf(nodeId: string, ids: string[], now: number): Promise<Map<string, Owner>> {
    const found = new Map<string, Owner>();
    const missing: string[] = [];
    for (const id of ids) {
      const hit = this.owners.get(cacheKey(nodeId, id));
      if (hit && hit.until > now) {
        if (hit.owner) found.set(id, hit.owner);
      } else {
        missing.push(id);
      }
    }
    if (missing.length === 0) return found;

    if (this.owners.size + missing.length > MAX_CACHED_OWNERS) this.owners.clear();
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const rows = await this.prisma.protocolUser.findMany({
        where: { nodeId, externalUserId: { in: chunk } },
        select: { externalUserId: true, protocol: true, subscription: { select: { customerId: true } } },
      });
      const byId = new Map<string, Owner>();
      for (const row of rows) {
        // externalUserId is unique on a node in practice (a UUID, a key, a
        // certificate name); if two protocols ever shared one, the first
        // row decides, and both belong to the same subscription anyway.
        if (!byId.has(row.externalUserId)) {
          byId.set(row.externalUserId, { customerId: row.subscription.customerId, protocol: row.protocol });
        }
      }
      for (const id of chunk) {
        const owner = byId.get(id) ?? null;
        this.owners.set(cacheKey(nodeId, id), { owner, until: now + (owner ? OWNER_TTL_MS : UNKNOWN_OWNER_TTL_MS) });
        if (owner) found.set(id, owner);
      }
    }
    return found;
  }

  /** Deletes everything last seen more than seven days ago. Called by the
   * sweeps queue; this is what keeps the privacy page's promise, not
   * tidying. */
  async prune(now: number = Date.now()): Promise<number> {
    const { count } = await this.prisma.siteVisit.deleteMany({
      where: { lastSeen: { lt: new Date(now - SITE_VISIT_RETENTION_DAYS * DAY_MS) } },
    });
    if (count > 0) this.logger.log(`Pruned ${count} site history row(s) older than ${SITE_VISIT_RETENTION_DAYS} days`);
    return count;
  }

  /** One customer's destinations over the last `days` (1 to 7), one row
   * per host, port and network, most recently seen first.
   *
   * Grouped, ordered and cut to `take` in Postgres, and counted there
   * separately. It used to group by node and protocol as well and fold
   * the groups here, which read every destination the customer had in
   * the window into memory before keeping the first 200 -- for a
   * customer whose client sprayed addresses all week, millions of groups
   * on one request. Only the page leaves the database now. */
  async sites(customerId: string, query: SitesQuery = {}, now: number = Date.now()): Promise<SitesView> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new NotFoundException("Customer not found");

    const days = boundedInt(query.days, 1, SITE_VISIT_RETENTION_DAYS, SITE_VISIT_RETENTION_DAYS);
    const take = boundedInt(query.take, 1, MAX_TAKE, DEFAULT_TAKE);
    const q = typeof query.q === "string" ? query.q.trim().slice(0, MAX_QUERY_LENGTH) : "";
    const since = new Date(now - days * DAY_MS);

    // lastSeen is TIMESTAMP(3) holding UTC; the bound goes in as text
    // pinned to UTC, as in DailyUsageService, so neither the driver's
    // parameter type nor the server's TimeZone can shift it. Served by
    // the (customerId, lastSeen) index. A search is a case-insensitive
    // substring of the host, with LIKE's own wildcards escaped so that
    // "_" or "%" typed into the box mean themselves.
    const scope = Prisma.sql`"customerId" = ${customerId}
        AND "lastSeen" >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        ${q ? Prisma.sql`AND "host" ILIKE ${`%${escapeLike(q)}%`}` : Prisma.empty}`;

    const rows = await this.prisma.$queryRaw<SiteGroupRow[]>(Prisma.sql`
      SELECT "host", "port", "network",
             SUM("count")::bigint AS "count",
             MIN("firstSeen") AS "firstSeen",
             MAX("lastSeen") AS "lastSeen",
             ARRAY_AGG(DISTINCT "nodeId") AS "nodeIds",
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT "protocol"), NULL) AS "protocols"
      FROM "site_visits"
      WHERE ${scope}
      GROUP BY "host", "port", "network"
      ORDER BY MAX("lastSeen") DESC, SUM("count") DESC, "host" ASC, "port" ASC, "network" ASC
      LIMIT ${take}::int`);
    const [counted] = await this.prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS "total"
      FROM (SELECT 1 FROM "site_visits" WHERE ${scope} GROUP BY "host", "port", "network") AS "destinations"`);

    const nodeIds = [...new Set(rows.flatMap((r) => r.nodeIds ?? []))];
    const nodes = nodeIds.length
      ? await this.prisma.node.findMany({ where: { id: { in: nodeIds } }, select: { id: true, name: true } })
      : [];
    const nodeName = new Map(nodes.map((n) => [n.id, n.name]));

    return {
      retentionDays: SITE_VISIT_RETENTION_DAYS,
      coverage: SITE_COVERAGE,
      total: Number(counted?.total ?? 0),
      sites: rows.map((r) => {
        const lastSeen = new Date(r.lastSeen);
        return {
          host: r.host,
          port: Number(r.port),
          network: r.network,
          owner: this.ownerOfHost(r.host),
          count: Number(r.count),
          firstSeen: (r.firstSeen ? new Date(r.firstSeen) : lastSeen).toISOString(),
          lastSeen: lastSeen.toISOString(),
          // A node deleted since is still a server the connection used;
          // its id is all that is left to name it by.
          servers: [...new Set((r.nodeIds ?? []).map((id) => nodeName.get(id) ?? id))].sort(),
          protocols: [...(r.protocols ?? [])].sort(),
        };
      }),
    };
  }

  /** The name of the network announcing `host`, when it is an address. */
  private ownerOfHost(host: string): string | null {
    const address = addressOf(host);
    if (!address) return null;
    return this.asn.lookup(address)?.org || null;
  }
}

/** `text` for use inside a LIKE pattern: backslash, percent and underscore
 * escaped with Postgres's default LIKE escape, the backslash. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function cacheKey(nodeId: string, externalUserId: string): string {
  return `${nodeId}\u0000${externalUserId}`;
}

/** An address literal inside `host`, unwrapped from brackets and from the
 * IPv4-in-IPv6 form, or null for a name. */
export function addressOf(host: string): string | null {
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const address = normaliseIp(unbracketed);
  return isIP(address) ? address : null;
}

/** Unix seconds, as the proto loader hands an int64 over (a string), to a
 * Date; null for zero, absent or nonsense. */
function secondsToDate(value: string | number | undefined | null): Date | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** One stored row, or null for a line that is not one. */
function rowOf(
  nodeId: string,
  owner: Owner,
  d: DestinationCountMessage,
  windowStart: Date,
  windowEnd: Date,
  now: number,
): Prisma.SiteVisitCreateManyInput | null {
  const host = typeof d.host === "string" ? d.host.trim() : "";
  if (!host || host.length > MAX_HOST_LENGTH) return null;
  const port = Number(d.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return null;
  const count = Math.min(Math.max(Math.trunc(Number(d.count)) || 1, 1), MAX_INT32);
  const network = typeof d.network === "string" && d.network ? d.network.toLowerCase().slice(0, 8) : "tcp";

  let lastSeen = secondsToDate(d.lastSeen) ?? windowEnd;
  if (lastSeen.getTime() > now + FUTURE_SKEW_MS) lastSeen = new Date(now);
  let firstSeen = secondsToDate(d.firstSeen) ?? windowStart;
  if (firstSeen.getTime() > lastSeen.getTime()) firstSeen = lastSeen;
  // Already past what is kept: the sweep would delete it on its next run.
  if (lastSeen.getTime() < now - SITE_VISIT_RETENTION_DAYS * DAY_MS) return null;

  return {
    customerId: owner.customerId,
    nodeId,
    externalUserId: d.externalUserId,
    protocol: owner.protocol,
    inboundTag: typeof d.inboundTag === "string" ? d.inboundTag.slice(0, MAX_TAG_LENGTH) : "",
    network,
    host,
    port,
    count,
    firstSeen,
    lastSeen,
  };
}

/** An integer query parameter, clamped to [min, max]; `fallback` when it
 * is absent or not a number. */
export function boundedInt(value: string | number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
