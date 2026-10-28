import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AsnLookupService } from "../network-identity/asn-lookup.service";
import { CustomerAuthService } from "../customer-auth/customer-auth.service";

/** "Connected now" means a usage record ending inside this window: the
 * nodes report traffic about every 30 seconds while it flows, so ten
 * minutes is twenty chances to have said so. It is a statement about
 * traffic the servers counted, not about an app's own state -- a tunnel
 * that is up and idle carries nothing and reads as not connected, and
 * that is the honest reading of what the server knows. */
export const LIVE_WINDOW_MS = 10 * 60_000;

/** reportedAt is stamped by the database as the row is written and
 * periodEnd by the backend a moment before, so the two agree to within
 * milliseconds. The filter on reportedAt is what lets Postgres use its
 * (nodeId, reportedAt) and (subscriptionId, reportedAt) indexes -- there
 * is none on periodEnd -- and this slack keeps it from cutting off a row
 * whose periodEnd is inside the window. */
const REPORTED_AT_SLACK_MS = 60_000;

/** Days of traffic shown, today included. */
export const TRAFFIC_DAYS = 14;

const DEFAULT_ATTEMPTS = 50;
const MAX_ATTEMPTS = 200;
/** A customer is capped at 10 signed-in devices; revoked sessions are
 * listed too, so this is a bound on the query rather than a page. */
const MAX_DEVICES = 50;
/** How many of a customer's subscriptions are asked for their last
 * traffic -- the most recently updated, since every usage report updates
 * its subscription's running total. */
const LAST_TRAFFIC_SUBSCRIPTIONS = 20;

const DAY_MS = 86_400_000;

/** Protocol shown for usage whose credential has since been deleted: the
 * row survives (it is billing history) but no longer says which protocol
 * carried it. */
const UNKNOWN_PROTOCOL = "unknown";

export interface ConnectedNow {
  nodeName: string;
  protocol: string;
  lastTrafficAt: string;
  bytesLast10Min: string;
}

export interface DeviceRow {
  sessionId: string;
  platform: string | null;
  label: string | null;
  channel: string | null;
  createdAt: string;
  lastUsedAt: string;
  revoked: boolean;
  appVersion: string | null;
}

export interface AttemptRung {
  protocol: string | null;
  server: string | null;
  result: string;
  carried: boolean | null;
}

export interface AttemptRow {
  id: string;
  at: string;
  kind: string;
  outcome: string;
  platform: string;
  appVersion: string;
  network: { asn: number; name: string | null } | null;
  /** The address the report came from -- null when that was one of our
   * own servers (see throughServer). */
  ip: string | null;
  /** The server the report came through, when it was sent through the
   * VPN: a connect's success report goes out through the tunnel it has
   * just opened, so the address it arrives from is the server's, not the
   * customer's. Null when it came straight from the customer. */
  throughServer: string | null;
  protocol: string | null;
  reason: string | null;
  sessionSeconds: number | null;
  rungs: AttemptRung[];
}

export interface TrafficRow {
  day: string;
  nodeName: string;
  protocol: string;
  bytesUp: string;
  bytesDown: string;
}

export interface CustomerActivity {
  now: { lastSeenAt: string | null; connected: ConnectedNow | null };
  devices: DeviceRow[];
  attempts: AttemptRow[];
  traffic: TrafficRow[];
}

export interface LiveUser {
  customerId: string;
  email: string;
  nodeName: string;
  protocol: string;
  lastTrafficAt: string;
  bytesLast10Min: string;
}

/** One customer+node+protocol with traffic in the live window. */
interface LiveRow {
  customerId: string;
  email: string;
  nodeName: string;
  protocol: string;
  lastTrafficAt: number;
  bytes: bigint;
}

interface RawTraffic {
  day: string;
  nodeId: string;
  protocol: string | null;
  up: string | null;
  down: string | null;
}

/** Everything staff need to answer "why can't this customer connect",
 * on one page: whether traffic is flowing now, which devices are signed
 * in and on what app version, every connect the apps reported with each
 * server and protocol they tried, and what the servers counted per day.
 *
 * Read-only apart from signing a device out, which is the same sign-out
 * the customer's own app performs (CustomerAuthService.revokeSession).
 *
 * Every figure is something a server measured or an app reported; the
 * attempt log is the apps' own account and is labelled as such in the
 * panel. Addresses come from the attempt log and are erased there after
 * 14 days, so `ip` is often null. */
@Injectable()
export class CustomerActivityService {
  private readonly logger = new Logger(CustomerActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly asn: AsnLookupService,
    private readonly auth: CustomerAuthService,
  ) {}

  async activity(
    customerId: string,
    options: { attemptsTake?: string | number } = {},
    now: number = Date.now(),
  ): Promise<CustomerActivity> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new NotFoundException("Customer not found");
    const take = boundedInt(options.attemptsTake, 1, MAX_ATTEMPTS, DEFAULT_ATTEMPTS);

    const subscriptions = await this.prisma.subscription.findMany({
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    const subscriptionIds = subscriptions.map((s) => s.id);

    const [live, lastTraffic, sessions, attempts, traffic] = await Promise.all([
      subscriptionIds.length ? this.liveRows({ subscriptionId: { in: subscriptionIds } }, now) : Promise.resolve([]),
      this.lastTrafficAt(subscriptionIds.slice(0, LAST_TRAFFIC_SUBSCRIPTIONS)),
      this.prisma.customerSession.findMany({
        where: { customerId },
        orderBy: { lastUsedAt: "desc" },
        take: MAX_DEVICES,
        select: {
          id: true,
          platform: true,
          label: true,
          channel: true,
          createdAt: true,
          lastUsedAt: true,
          revokedAt: true,
        },
      }),
      this.prisma.clientAttempt.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take,
        select: {
          id: true,
          kind: true,
          outcome: true,
          platform: true,
          appVersion: true,
          asn: true,
          ip: true,
          protocol: true,
          reason: true,
          sessionSeconds: true,
          attemptsJson: true,
          occurredAt: true,
          createdAt: true,
        },
      }),
      subscriptionIds.length ? this.traffic(customerId, now) : Promise.resolve([]),
    ]);

    const [versions, rungsById] = await Promise.all([
      this.appVersions(customerId, sessions.map((s) => s.platform)),
      this.rungsOf(attempts),
    ]);

    // The newest moment the server heard from this customer at all:
    // traffic its nodes counted, a token refresh, or an attempt report.
    const heard = [
      lastTraffic?.getTime(),
      ...sessions.map((s) => s.lastUsedAt.getTime()),
      attempts[0]?.createdAt.getTime(),
    ].filter((t): t is number => typeof t === "number");
    const lastSeenAt = heard.length ? new Date(Math.max(...heard)).toISOString() : null;

    const newest = live[0];
    // Our servers' addresses, to recognise a report that came through one
    // of them. Read here rather than cached: a server's address changes
    // when it is replaced.
    const servers = await this.prisma.node.findMany({ select: { name: true, publicIp: true } });
    const serverAt = new Map(servers.map((n) => [n.publicIp, n.name]));

    return {
      now: {
        lastSeenAt,
        connected: newest
          ? {
              nodeName: newest.nodeName,
              protocol: newest.protocol,
              lastTrafficAt: new Date(newest.lastTrafficAt).toISOString(),
              bytesLast10Min: newest.bytes.toString(),
            }
          : null,
      },
      devices: sessions.map((s) => ({
        sessionId: s.id,
        platform: s.platform,
        label: s.label,
        channel: s.channel,
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        revoked: s.revokedAt !== null,
        appVersion: (s.platform && versions.get(s.platform)) ?? null,
      })),
      attempts: attempts.map((a) => ({
        id: a.id,
        // When the app says it happened, where it said and that is
        // plausible; else when it arrived. A report queued through an
        // outage arrives hours late, and it is the outage that matters.
        at: (a.occurredAt ?? a.createdAt).toISOString(),
        kind: a.kind,
        outcome: a.outcome,
        platform: a.platform,
        appVersion: a.appVersion,
        network: a.asn === null ? null : { asn: a.asn, name: this.asn.orgOf(a.asn) || null },
        ip: a.ip !== null && serverAt.has(a.ip) ? null : a.ip,
        throughServer: a.ip !== null ? (serverAt.get(a.ip) ?? null) : null,
        protocol: a.protocol,
        reason: a.reason,
        sessionSeconds: a.sessionSeconds,
        rungs: rungsById.get(a.id) ?? [],
      })),
      traffic,
    };
  }

  /** Every customer with traffic counted in the last ten minutes, newest
   * first, one row per customer, server and protocol. */
  async live(now: number = Date.now()): Promise<{ at: string; users: LiveUser[] }> {
    const rows = await this.liveRows({}, now);
    return {
      at: new Date(now).toISOString(),
      users: rows.map((r) => ({
        customerId: r.customerId,
        email: r.email,
        nodeName: r.nodeName,
        protocol: r.protocol,
        lastTrafficAt: new Date(r.lastTrafficAt).toISOString(),
        bytesLast10Min: r.bytes.toString(),
      })),
    };
  }

  /** Signs one of the customer's devices out, exactly as the device
   * signing itself out would: the session revoked, its own VPN
   * credentials taken off the nodes, its device slot freed. A device on
   * the subscription's shared credentials (an app from before per-device
   * credentials) keeps its tunnel until those change; its next token
   * refresh is refused all the same.
   *
   * A session that is not this customer's is a 404, the same as one that
   * never existed. One already signed out is signed out again, which
   * retries taking its credentials off any node that missed it the first
   * time. The admin audit records who did it (AdminAuditInterceptor). */
  async signOutSession(customerId: string, sessionId: string, by: string): Promise<{ ok: true }> {
    const session = await this.prisma.customerSession.findFirst({
      where: { id: sessionId, customerId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException("Device session not found");
    await this.auth.revokeSession(customerId, session.id);
    this.logger.log(`Customer ${customerId}: session ${session.id} signed out by staff (${by})`);
    return { ok: true };
  }

  /** Usage records ending inside the live window, folded to one row per
   * customer, server and protocol, newest first. `scope` narrows it to
   * one customer's subscriptions; empty means everyone. */
  private async liveRows(scope: Prisma.UsageRecordWhereInput, now: number): Promise<LiveRow[]> {
    const since = now - LIVE_WINDOW_MS;
    const nodes = await this.prisma.node.findMany({ select: { id: true, name: true } });
    if (nodes.length === 0) return [];
    const nodeName = new Map(nodes.map((n) => [n.id, n.name]));

    // The node list in the filter is what makes the everyone-at-once case
    // an index range scan per node rather than a scan of the whole table.
    const groups = await this.prisma.usageRecord.groupBy({
      by: ["subscriptionId", "nodeId", "protocolUserId"],
      where: {
        ...scope,
        nodeId: { in: nodes.map((n) => n.id) },
        reportedAt: { gte: new Date(since - REPORTED_AT_SLACK_MS) },
        periodEnd: { gte: new Date(since) },
        // Only rows where the device sent something. A WireGuard peer
        // whose device has gone keeps receiving the server's handshake
        // attempts -- download, no upload -- and every such customer read
        // as "live" (ConcurrencyService says the same for the device limit).
        bytesUp: { gt: 0 },
      },
      _sum: { bytesUp: true, bytesDown: true },
      _max: { periodEnd: true },
    });
    if (groups.length === 0) return [];

    const protocolUserIds = [...new Set(groups.map((g) => g.protocolUserId).filter((id): id is string => !!id))];
    const subscriptionIds = [...new Set(groups.map((g) => g.subscriptionId))];
    const [protocolUsers, subscriptions] = await Promise.all([
      protocolUserIds.length
        ? this.prisma.protocolUser.findMany({ where: { id: { in: protocolUserIds } }, select: { id: true, protocol: true } })
        : Promise.resolve([]),
      this.prisma.subscription.findMany({
        where: { id: { in: subscriptionIds } },
        select: { id: true, customerId: true, customer: { select: { email: true } } },
      }),
    ]);
    const protocolOf = new Map(protocolUsers.map((p) => [p.id, p.protocol as string]));
    const ownerOf = new Map(subscriptions.map((s) => [s.id, { customerId: s.customerId, email: s.customer.email }]));

    const folded = new Map<string, LiveRow>();
    for (const g of groups) {
      const owner = ownerOf.get(g.subscriptionId);
      if (!owner) continue;
      const protocol = (g.protocolUserId && protocolOf.get(g.protocolUserId)) || UNKNOWN_PROTOCOL;
      const key = `${owner.customerId}\u0000${g.nodeId}\u0000${protocol}`;
      const bytes = (g._sum.bytesUp ?? 0n) + (g._sum.bytesDown ?? 0n);
      const last = g._max.periodEnd?.getTime() ?? 0;
      const row = folded.get(key);
      if (row) {
        row.bytes += bytes;
        row.lastTrafficAt = Math.max(row.lastTrafficAt, last);
      } else {
        folded.set(key, {
          customerId: owner.customerId,
          email: owner.email,
          nodeName: nodeName.get(g.nodeId) ?? g.nodeId,
          protocol,
          lastTrafficAt: last,
          bytes,
        });
      }
    }
    return [...folded.values()]
      .filter((r) => r.bytes > 0n)
      .sort((a, b) => b.lastTrafficAt - a.lastTrafficAt || a.email.localeCompare(b.email));
  }

  /** The newest usage report across these subscriptions, one indexed
   * lookup each. */
  private async lastTrafficAt(subscriptionIds: string[]): Promise<Date | null> {
    if (subscriptionIds.length === 0) return null;
    const newest = await Promise.all(
      subscriptionIds.map((subscriptionId) =>
        this.prisma.usageRecord.findFirst({
          // Sent by the device, as in liveRows: the server's handshake
          // attempts to a WireGuard peer that has gone are not "seen".
          where: { subscriptionId, bytesUp: { gt: 0 } },
          orderBy: { reportedAt: "desc" },
          select: { reportedAt: true },
        }),
      ),
    );
    const times = newest.filter((r): r is { reportedAt: Date } => !!r).map((r) => r.reportedAt.getTime());
    return times.length ? new Date(Math.max(...times)) : null;
  }

  /** Traffic per UTC day, server and protocol, for the last TRAFFIC_DAYS
   * days, newest day first. From the same rows that count against the
   * plan's cap; bytes as decimal strings, since a month of a busy
   * customer's traffic passes what a JSON number holds exactly.
   *
   * reportedAt is TIMESTAMP(3) holding UTC, so truncating it to the day
   * gives the UTC day. The lower bound is passed as text and pinned to
   * UTC, as DailyUsageService does, so neither the driver's parameter
   * type nor the server's TimeZone can shift it. */
  private async traffic(customerId: string, now: number): Promise<TrafficRow[]> {
    const since = new Date(Math.floor(now / DAY_MS) * DAY_MS - (TRAFFIC_DAYS - 1) * DAY_MS);
    const rows = await this.prisma.$queryRaw<RawTraffic[]>`
      SELECT to_char(date_trunc('day', u."reportedAt"), 'YYYY-MM-DD') AS "day",
             u."nodeId" AS "nodeId",
             p."protocol"::text AS "protocol",
             SUM(u."bytesUp")::text AS "up",
             SUM(u."bytesDown")::text AS "down"
      FROM "usage_records" u
      LEFT JOIN "protocol_users" p ON p."id" = u."protocolUserId"
      WHERE u."subscriptionId" IN (SELECT "id" FROM "subscriptions" WHERE "customerId" = ${customerId})
        AND u."reportedAt" >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY 1, 2, 3`;
    if (rows.length === 0) return [];

    const nodeIds = [...new Set(rows.map((r) => r.nodeId))];
    const nodes = await this.prisma.node.findMany({ where: { id: { in: nodeIds } }, select: { id: true, name: true } });
    const nodeName = new Map(nodes.map((n) => [n.id, n.name]));

    // Merged here rather than trusted to the GROUP BY alone: two deleted
    // credentials on one server on one day are two NULL protocols there
    // and one "unknown" here.
    const merged = new Map<string, { day: string; nodeName: string; protocol: string; up: bigint; down: bigint }>();
    for (const r of rows) {
      const name = nodeName.get(r.nodeId) ?? r.nodeId;
      const protocol = r.protocol ?? UNKNOWN_PROTOCOL;
      const key = `${r.day}\u0000${name}\u0000${protocol}`;
      const entry = merged.get(key) ?? { day: r.day, nodeName: name, protocol, up: 0n, down: 0n };
      entry.up += BigInt(r.up ?? "0");
      entry.down += BigInt(r.down ?? "0");
      merged.set(key, entry);
    }
    return [...merged.values()]
      .sort(
        (a, b) =>
          b.day.localeCompare(a.day) || a.nodeName.localeCompare(b.nodeName) || a.protocol.localeCompare(b.protocol),
      )
      .map((e) => ({
        day: e.day,
        nodeName: e.nodeName,
        protocol: e.protocol,
        bytesUp: e.up.toString(),
        bytesDown: e.down.toString(),
      }));
  }

  /** The newest app version each platform reported, from this customer's
   * own attempt reports -- the only place the server learns it. A session
   * row says which platform a device is, not which build. */
  private async appVersions(customerId: string, platforms: (string | null)[]): Promise<Map<string, string>> {
    const distinct = [...new Set(platforms.filter((p): p is string => !!p))];
    const found = await Promise.all(
      distinct.map(async (platform) => {
        const row = await this.prisma.clientAttempt.findFirst({
          where: { customerId, platform },
          orderBy: { createdAt: "desc" },
          select: { appVersion: true },
        });
        return [platform, row?.appVersion] as const;
      }),
    );
    return new Map(found.filter((f): f is readonly [string, string] => !!f[1]));
  }

  /** Each attempt's ladder, its route ids named as servers. */
  private async rungsOf(
    attempts: { id: string; attemptsJson: Prisma.JsonValue | null }[],
  ): Promise<Map<string, AttemptRung[]>> {
    const parsed = attempts.map((a) => ({ id: a.id, rungs: parseRungs(a.attemptsJson) }));
    const routeIds = [
      ...new Set(parsed.flatMap((p) => p.rungs.map((r) => r.routeId)).filter((id): id is string => !!id)),
    ];
    const servers = await this.serverNames(routeIds);
    return new Map(
      parsed.map((p) => [
        p.id,
        p.rungs.map((r) => ({
          protocol: r.protocol,
          server: r.routeId ? (servers.get(r.routeId) ?? null) : null,
          result: r.result,
          carried: r.carried,
        })),
      ]),
    );
  }

  /** A route's server as staff know it: the node's name, or for a relayed
   * route "<entry> -> <exit>", since the customer dialled the first and
   * came out at the second. A route deleted since has no name. */
  private async serverNames(routeIds: string[]): Promise<Map<string, string>> {
    if (routeIds.length === 0) return new Map();
    const routes = await this.prisma.route.findMany({
      where: { id: { in: routeIds } },
      select: {
        id: true,
        entryProtocolConfig: { select: { node: { select: { name: true } } } },
        exitProtocolConfig: { select: { node: { select: { name: true } } } },
      },
    });
    return new Map(
      routes.map((r) => {
        const entry = r.entryProtocolConfig.node.name;
        const exit = r.exitProtocolConfig?.node.name;
        return [r.id, exit ? `${entry} -> ${exit}` : entry];
      }),
    );
  }
}

interface ParsedRung {
  protocol: string | null;
  routeId: string | null;
  result: string;
  carried: boolean | null;
}

/** The ladder a client reported, as stored by ClientAttemptsService:
 * an array of { protocol, result, routeId?, carried? }, validated on the
 * way in. Read defensively all the same -- rows from older backends, and
 * whatever a future client sends, should show as what they are rather
 * than break the page. */
export function parseRungs(json: Prisma.JsonValue | null): ParsedRung[] {
  if (!Array.isArray(json)) return [];
  const rungs: ParsedRung[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const rung = item as Record<string, unknown>;
    rungs.push({
      protocol: typeof rung.protocol === "string" ? rung.protocol : null,
      routeId: typeof rung.routeId === "string" && rung.routeId ? rung.routeId : null,
      result: typeof rung.result === "string" ? rung.result : "",
      carried: typeof rung.carried === "boolean" ? rung.carried : null,
    });
  }
  return rungs;
}

/** A whole number from a query parameter, clamped to [min, max]; the
 * fallback when it is absent or not a number. */
export function boundedInt(value: string | number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
