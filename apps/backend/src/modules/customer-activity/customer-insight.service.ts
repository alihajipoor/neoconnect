import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AdminRole, ClientAttemptKind, ClientAttemptOutcome, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AsnLookupService } from "../network-identity/asn-lookup.service";
import { UpdatesService, compareVersions } from "../updates/updates.service";
import { happenedAt, WINDOW_HOURS } from "../isp-recommendations/isp-signal";
import { listWindow, type Page } from "../../common/pagination";
import { boundedInt, CustomerActivityService, parseRungs, type AttemptSource } from "./customer-activity.service";
import { parseApiTrace } from "./api-trace";
import {
  classifyFailure,
  classifyReport,
  FAILURE_LABELS,
  isConnectAttempt,
  reportFailureCode,
  rungConnected,
  rungFailed,
  rungNotDialled,
  scrubAddresses,
  type FailureCode,
  type ReportCategory,
} from "./insight-classify";
import { findingsFor } from "./insight-findings";
import { buildSessions, type UsagePeriod } from "./usage-sessions";
import type {
  CustomerAttemptDetail,
  CustomerHistoryEvent,
  CustomerInsight,
  CustomerUsage,
  InsightApp,
  InsightCredentials,
  InsightFailure,
  InsightNetwork,
  InsightNetworkRef,
  InsightRoute,
  InsightVoucher,
  UsageHour,
} from "./customer-insight.types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A customer's reports in the window, at most. Reports are kept 60 days
 * (KEEP_WITHOUT_ADDRESS_DAYS) and a busy customer sends a few thousand
 * in that time, so this bounds the read without cutting a real window;
 * past it the oldest rows in the window are left out. */
export const ROW_CAP = 5000;
/** Other customers' reports read per network for `others`. A large
 * operator's 48 hours can pass this; the count is then over the newest. */
const OTHERS_ROW_CAP = 5000;
/** Networks asked about `others`, the customer's busiest first. */
const OTHERS_NETWORKS = 10;
/** Fewer other customers than this and `others` is null. */
export const OTHERS_MIN_CUSTOMERS = 3;
/** Upload periods read to rebuild sessions, newest first. */
const SESSION_PERIOD_CAP = 20_000;
/** Each source of the history is read up to this many rows. */
const HISTORY_SOURCE_CAP = 200;
const USAGE_DAYS = 30;
const UNKNOWN_PROTOCOL = "unknown";

const ATTEMPT_SELECT = {
  id: true,
  routeId: true,
  kind: true,
  outcome: true,
  platform: true,
  appVersion: true,
  asn: true,
  ip: true,
  via: true,
  protocol: true,
  reason: true,
  sessionSeconds: true,
  attemptsJson: true,
  apiEndpoint: true,
  occurredAt: true,
  createdAt: true,
} satisfies Prisma.ClientAttemptSelect;

type AttemptRecord = AttemptSource & { apiEndpoint: string | null };

/** A report with what the insight derives from it, once. */
interface Derived {
  row: AttemptRecord;
  at: number;
  rungs: ReturnType<typeof parseRungs>;
  category: ReportCategory;
  attempt: boolean;
  failureCode: FailureCode | null;
}

function derive(row: AttemptRecord): Derived {
  const rungs = parseRungs(row.attemptsJson);
  const like = { kind: row.kind, outcome: row.outcome, reason: row.reason, hasRungs: rungs.length > 0 };
  const category = classifyReport(like);
  return {
    row,
    at: happenedAt(row),
    rungs,
    category,
    attempt: isConnectAttempt(like, category),
    failureCode: reportFailureCode({ ...like, rungResults: rungs.map((r) => r.result) }, category),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** An audited path with every id cut to its first eight characters. */
export function shortenIds(path: string): string {
  return path.replace(UUID, (id) => `${id.slice(0, 8)}…`);
}

export interface AttemptQuery {
  take?: string;
  skip?: string;
  kind?: string;
  outcome?: string;
  category?: string;
  failureCode?: string;
  platform?: string;
  asn?: string;
  from?: string;
  to?: string;
  q?: string;
}

const CATEGORIES: ReportCategory[] = ["connect", "reconnect", "api", "config", "cancelled", "session", "signin", "register", "other"];

/** Troubleshooting one customer in depth, without SQL: what their apps
 * reported, read and counted (`insight`); every report, filterable
 * (`attempts`); what the servers counted, by hour and by session
 * (`usage`); and what happened to the account (`history`).
 *
 * Read-only. Every figure is either something a server counted or an
 * app reported, and the findings say which counts they rest on rather
 * than what might have caused them (insight-findings.ts). */
@Injectable()
export class CustomerInsightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: CustomerActivityService,
    private readonly asn: AsnLookupService,
    private readonly updates: UpdatesService,
  ) {}

  private network(asn: number | null): InsightNetworkRef | null {
    return asn === null ? null : { asn, name: this.asn.orgOf(asn) || null };
  }

  async insight(customerId: string, options: { days?: string | number } = {}, now: number = Date.now()): Promise<CustomerInsight> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        email: true,
        createdAt: true,
        emailVerifiedAt: true,
        status: true,
        locale: true,
        signupChannel: true,
        referredBy: { select: { id: true, email: true } },
        identities: { select: { provider: true, createdAt: true, lastUsedAt: true }, orderBy: { createdAt: "asc" } },
        _count: { select: { referrals: true } },
      },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    const windowDays = boundedInt(options.days, 1, 60, 7);
    const since = now - windowDays * DAY_MS;

    const [fetched, newestEver, credentials, vouchers] = await Promise.all([
      this.prisma.clientAttempt.findMany({
        // Arrival bounds the read (it is indexed and a client's clock
        // cannot widen it); the window is then applied to when each
        // report says it happened, which is never later than arrival.
        where: { customerId, createdAt: { gte: new Date(since) } },
        orderBy: { createdAt: "desc" },
        take: ROW_CAP,
        select: ATTEMPT_SELECT,
      }),
      this.prisma.clientAttempt.findFirst({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        select: ATTEMPT_SELECT,
      }),
      this.credentials(customerId, now),
      this.vouchers(customerId, customer.email),
    ]);
    const rows = fetched
      .map(derive)
      .filter((d) => d.at >= since)
      .sort((a, b) => b.at - a.at);
    const attempts = rows.filter((d) => d.attempt);

    // Every route a rung or a landing named, as staff know the server.
    const routeIds = new Set<string>();
    for (const d of rows) {
      if (d.row.routeId) routeIds.add(d.row.routeId);
      for (const r of d.rungs) if (r.routeId) routeIds.add(r.routeId);
    }
    const serverOf = await this.activity.serverNames([...routeIds]);

    const reports = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<ReportCategory, number>;
    for (const d of rows) reports[d.category] += 1;

    const apps = this.apps(rows, newestEver ? derive(newestEver) : null);
    const networks = await this.networks(customerId, rows, now);

    const successes = attempts.filter((d) => d.row.outcome === "SUCCESS");
    const lastOk = successes[0];
    const lastBad = attempts.find((d) => d.row.outcome !== "SUCCESS");
    const byOutcome = new Map<string, number>();
    for (const d of attempts) byOutcome.set(d.row.outcome, (byOutcome.get(d.row.outcome) ?? 0) + 1);

    const failures = this.failures(rows);
    const sessionRows = rows.filter((d) => d.category === "session");
    const seconds = sessionRows.map((d) => d.row.sessionSeconds ?? 0);

    const newestDerived = newestEver ? derive(newestEver) : null;
    const findings = findingsFor({
      now,
      windowDays,
      emailVerifiedAt: customer.emailVerifiedAt?.toISOString() ?? null,
      apps,
      tried: attempts.length,
      succeeded: successes.length,
      networks,
      failures,
      credentials,
      vouchers,
      lastReport: newestDerived ? { at: iso(newestDerived.at), category: newestDerived.category } : null,
    });

    return {
      windowDays,
      generatedAt: iso(now),
      account: {
        createdAt: customer.createdAt.toISOString(),
        emailVerifiedAt: customer.emailVerifiedAt?.toISOString() ?? null,
        status: customer.status,
        locale: customer.locale,
        signupChannel: customer.signupChannel,
        identities: customer.identities.map((i) => ({
          provider: i.provider,
          createdAt: i.createdAt.toISOString(),
          lastUsedAt: i.lastUsedAt.toISOString(),
        })),
        referredBy: customer.referredBy ? { customerId: customer.referredBy.id, email: customer.referredBy.email } : null,
        referralsMade: customer._count.referrals,
      },
      apps,
      reports,
      connect: {
        tried: attempts.length,
        succeeded: successes.length,
        lastSuccess: lastOk
          ? {
              at: iso(lastOk.at),
              server: lastOk.row.routeId ? (serverOf.get(lastOk.row.routeId) ?? null) : null,
              protocol: lastOk.row.protocol,
              network: this.network(lastOk.row.asn),
              platform: lastOk.row.platform,
              appVersion: lastOk.row.appVersion,
            }
          : null,
        lastFailure: lastBad
          ? {
              at: iso(lastBad.at),
              outcome: lastBad.row.outcome,
              reason: lastBad.row.reason,
              network: this.network(lastBad.row.asn),
              platform: lastBad.row.platform,
              appVersion: lastBad.row.appVersion,
            }
          : null,
        byOutcome: [...byOutcome].map(([outcome, count]) => ({ outcome, count })).sort((a, b) => b.count - a.count),
      },
      networks,
      routes: this.routes(rows, serverOf),
      failures,
      sessions: {
        count: sessionRows.length,
        totalSeconds: seconds.reduce((a, b) => a + b, 0),
        longestSeconds: seconds.length ? Math.max(...seconds) : 0,
        lastAt: sessionRows[0] ? iso(sessionRows[0].at) : null,
      },
      credentials,
      vouchers,
      findings,
    };
  }

  /** The newest app version per platform in the window, or the newest
   * report ever when the window has none. */
  private apps(rows: Derived[], newestEver: Derived | null): InsightApp[] {
    const source = rows.length > 0 ? rows : newestEver ? [newestEver] : [];
    const seen = new Map<string, Derived>();
    for (const d of source) if (!seen.has(d.row.platform)) seen.set(d.row.platform, d);
    return [...seen.values()].map((d) => {
      const latestVersion = this.updates.cachedVersion(d.row.platform);
      return {
        platform: d.row.platform,
        appVersion: d.row.appVersion,
        lastSeenAt: iso(d.at),
        latestVersion,
        behind: latestVersion === null ? null : compareVersions(latestVersion, d.row.appVersion) > 0,
      };
    });
  }

  private async networks(customerId: string, rows: Derived[], now: number): Promise<InsightNetwork[]> {
    const byAsn = new Map<number | null, InsightNetwork & { rows: number }>();
    for (const d of rows) {
      const asn = d.row.asn;
      let n = byAsn.get(asn);
      if (!n) {
        n = {
          asn,
          name: asn === null ? null : this.asn.orgOf(asn) || null,
          country: asn === null ? null : this.asn.countryOfAsn(asn),
          tried: 0,
          succeeded: 0,
          apiUnreachable: 0,
          lastAt: null,
          lastSuccessAt: null,
          others: null,
          rows: 0,
        };
        byAsn.set(asn, n);
      }
      n.rows += 1;
      if (n.lastAt === null) n.lastAt = iso(d.at); // rows are newest first
      if (d.attempt) {
        n.tried += 1;
        if (d.row.outcome === "SUCCESS") {
          n.succeeded += 1;
          if (n.lastSuccessAt === null) n.lastSuccessAt = iso(d.at);
        }
      }
      if (d.category === "api" && d.row.outcome === "CONTROL_PLANE_UNREACHABLE") n.apiUnreachable += 1;
    }

    const known = [...byAsn.values()]
      .filter((n) => n.asn !== null)
      .sort((a, b) => b.rows - a.rows)
      .slice(0, OTHERS_NETWORKS);
    await Promise.all(
      known.map(async (n) => {
        n.others = await this.othersOn(n.asn!, customerId, now);
      }),
    );

    return [...byAsn.values()]
      .sort((a, b) => b.tried - a.tried || b.rows - a.rows)
      .map((n) => {
        const { rows, ...network } = n;
        void rows;
        return network;
      });
  }

  /** How other signed-in customers fared on one network in the last
   * WINDOW_HOURS (the per-ISP tags' window): who made a connection
   * attempt, and who of them connected at least once. Null below
   * OTHERS_MIN_CUSTOMERS. Read through the (asn, createdAt) index. */
  private async othersOn(asn: number, customerId: string, now: number) {
    const rows = await this.prisma.clientAttempt.findMany({
      where: {
        asn,
        kind: ClientAttemptKind.CONNECT,
        createdAt: { gte: new Date(now - WINDOW_HOURS * HOUR_MS) },
        AND: [{ customerId: { not: null } }, { customerId: { not: customerId } }],
      },
      orderBy: { createdAt: "desc" },
      take: OTHERS_ROW_CAP,
      select: { customerId: true, kind: true, outcome: true, reason: true, attemptsJson: true },
    });
    const tried = new Set<string>();
    const connected = new Set<string>();
    for (const r of rows) {
      const like = { kind: r.kind, outcome: r.outcome, reason: r.reason, hasRungs: Array.isArray(r.attemptsJson) && r.attemptsJson.length > 0 };
      if (!r.customerId || !isConnectAttempt(like)) continue;
      tried.add(r.customerId);
      if (r.outcome === "SUCCESS") connected.add(r.customerId);
    }
    if (tried.size < OTHERS_MIN_CUSTOMERS) return null;
    return { customers: tried.size, connected: connected.size, hours: WINDOW_HOURS };
  }

  private routes(rows: Derived[], serverOf: Map<string, string>): InsightRoute[] {
    const routes = new Map<string, InsightRoute & { down: number[]; up: number[] }>();
    for (const d of rows) {
      if (d.category !== "connect" && d.category !== "reconnect") continue;
      for (const rung of d.rungs) {
        const server = rung.routeId ? (serverOf.get(rung.routeId) ?? null) : null;
        // A deleted route has no name; it stays apart from the others.
        const serverKey = server ?? (rung.routeId ? `route:${rung.routeId}` : "");
        const key = `${serverKey}\u0000${rung.protocol ?? ""}`;
        let route = routes.get(key);
        if (!route) {
          // Rows are newest first: the first rung seen is the latest.
          route = {
            server,
            protocol: rung.protocol,
            dialled: 0,
            connected: 0,
            carried: 0,
            notDialled: 0,
            medianDownKbps: null,
            medianUpKbps: null,
            lastResult: rung.result,
            lastAt: iso(d.at),
            down: [],
            up: [],
          };
          routes.set(key, route);
        }
        if (rungNotDialled(rung.result)) {
          route.notDialled += 1;
          continue;
        }
        route.dialled += 1;
        if (rungConnected(rung.result)) route.connected += 1;
        if (rung.carried === true) route.carried += 1;
        if (rung.downKbps !== null) route.down.push(rung.downKbps);
        if (rung.upKbps !== null) route.up.push(rung.upKbps);
      }
    }
    return [...routes.values()]
      .map(({ down, up, ...r }) => ({ ...r, medianDownKbps: median(down), medianUpKbps: median(up) }))
      .sort((a, b) => b.dialled - a.dialled || b.lastAt.localeCompare(a.lastAt));
  }

  /** Causes across failed reports and failed rungs. A report with failed
   * rungs is counted by its rungs, since its reason is usually the last
   * rung's words again; a report without is counted by its reason. */
  private failures(rows: Derived[]): InsightFailure[] {
    const groups = new Map<FailureCode, InsightFailure>();
    const add = (code: FailureCode, at: number, text: string) => {
      const g = groups.get(code);
      if (g) {
        g.count += 1;
        return;
      }
      // Rows are newest first, so the first text is the newest.
      groups.set(code, { code, label: FAILURE_LABELS[code], count: 1, lastAt: iso(at), example: scrubAddresses(text) });
    };
    for (const d of rows) {
      if (d.category === "session" || d.category === "config") continue;
      const failedRungs = d.category === "connect" || d.category === "reconnect" || d.category === "cancelled"
        ? d.rungs.filter((r) => rungFailed(r.result))
        : [];
      for (const rung of failedRungs) add(classifyFailure(rung.result), d.at, `${rung.protocol ?? "?"}: ${rung.result}`);
      if (d.failureCode && (failedRungs.length === 0 || d.failureCode === "CANCELLED_BY_CUSTOMER")) {
        add(d.failureCode, d.at, d.row.reason ?? d.row.outcome);
      }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
  }

  /** Per subscription, its credentials counted by state. Named columns
   * only: credentialsJson is never read here. */
  private async credentials(customerId: string, now: number): Promise<InsightCredentials[]> {
    const subscriptions = await this.prisma.subscription.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        status: true,
        startAt: true,
        expireAt: true,
        dataCapBytes: true,
        dataUsedBytes: true,
        plan: { select: { name: true } },
      },
    });
    if (subscriptions.length === 0) return [];
    const users = await this.prisma.protocolUser.findMany({
      where: { subscriptionId: { in: subscriptions.map((s) => s.id) } },
      take: ROW_CAP,
      select: { subscriptionId: true, protocol: true, status: true, provisionedAt: true, heldUntil: true, sessionId: true },
    });
    return subscriptions.map((s) => {
      const mine = users.filter((u) => u.subscriptionId === s.id);
      const byProtocol = new Map<string, number>();
      for (const u of mine) byProtocol.set(u.protocol, (byProtocol.get(u.protocol) ?? 0) + 1);
      return {
        subscriptionId: s.id,
        planName: s.plan.name,
        status: s.status,
        startAt: s.startAt.toISOString(),
        expireAt: s.expireAt.toISOString(),
        dataCapBytes: s.dataCapBytes === null ? null : s.dataCapBytes.toString(),
        dataUsedBytes: s.dataUsedBytes.toString(),
        total: mine.length,
        active: mine.filter((u) => u.status === "ACTIVE").length,
        notProvisioned: mine.filter((u) => u.provisionedAt === null).length,
        held: mine.filter((u) => u.heldUntil !== null && u.heldUntil.getTime() > now).length,
        perDevice: mine.filter((u) => u.sessionId !== null).length,
        byProtocol: [...byProtocol].map(([protocol, count]) => ({ protocol, count })).sort((a, b) => b.count - a.count),
      };
    });
  }

  /** Codes issued for this customer's address, and codes they redeemed.
   * The code itself is not returned: it is what redeems. */
  private async vouchers(customerId: string, email: string): Promise<InsightVoucher[]> {
    const vouchers = await this.prisma.voucher.findMany({
      where: {
        OR: [{ recipientEmail: { equals: email, mode: "insensitive" } }, { redemptions: { some: { customerId } } }],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        createdAt: true,
        recipientEmail: true,
        maxRedemptions: true,
        redeemedCount: true,
        plan: { select: { name: true } },
        issuedBy: { select: { email: true } },
        redemptions: {
          orderBy: { redeemedAt: "desc" },
          take: 50,
          select: { redeemedAt: true, customerId: true, subscriptionId: true },
        },
      },
    });
    return vouchers.map((v) => ({
      voucherId: v.id,
      planName: v.plan.name,
      issuedAt: v.createdAt.toISOString(),
      issuedByEmail: v.issuedBy?.email ?? null,
      issuedToThisEmail: (v.recipientEmail ?? "").toLowerCase() === email.toLowerCase(),
      maxRedemptions: v.maxRedemptions,
      redeemedCount: v.redeemedCount,
      redemptions: v.redemptions.map((r) => ({
        redeemedAt: r.redeemedAt.toISOString(),
        customerId: r.customerId,
        sameAccount: r.customerId === customerId,
        subscriptionId: r.subscriptionId,
      })),
    }));
  }

  /** Every report of the customer's, newest first, filtered. */
  async attempts(customerId: string, query: AttemptQuery, now: number = Date.now()): Promise<Page<CustomerAttemptDetail>> {
    await this.mustExist(customerId);
    const window = listWindow(query, { defaultTake: 50, maxTake: 200 });

    const where: Prisma.ClientAttemptWhereInput = { customerId };
    if (query.kind) {
      if (!(Object.values(ClientAttemptKind) as string[]).includes(query.kind)) throw new BadRequestException("Unknown kind");
      where.kind = query.kind as ClientAttemptKind;
    }
    if (query.outcome) {
      if (!(Object.values(ClientAttemptOutcome) as string[]).includes(query.outcome)) throw new BadRequestException("Unknown outcome");
      where.outcome = query.outcome as ClientAttemptOutcome;
    }
    if (query.platform) where.platform = query.platform;
    if (query.asn) {
      const asn = Number(query.asn);
      if (!Number.isInteger(asn) || asn < 0) throw new BadRequestException("asn must be a whole number");
      where.asn = asn;
    }
    // On arrival time, which is indexed and the server's own; a report's
    // own time is never later than it.
    const range: Prisma.DateTimeFilter = {};
    for (const [key, value] of [["gte", query.from], ["lte", query.to]] as const) {
      if (!value) continue;
      const ms = Date.parse(value);
      if (Number.isNaN(ms)) throw new BadRequestException(`${key === "gte" ? "from" : "to"} must be an ISO date`);
      range[key] = new Date(ms);
    }
    if (range.gte || range.lte) where.createdAt = range;
    if (query.category && !(CATEGORIES as string[]).includes(query.category)) throw new BadRequestException("Unknown category");
    if (query.failureCode && !(query.failureCode in FAILURE_LABELS)) throw new BadRequestException("Unknown failureCode");

    const needle = query.q?.trim().toLowerCase() ?? "";
    const derivedFilter = !!query.category || !!query.failureCode || needle !== "";
    let page: Derived[];
    let total: number;
    if (derivedFilter) {
      // Category, failure code and the text search are worked out from
      // each row, so they are filtered here. A customer has at most a few
      // thousand reports in the 60 days kept; ROW_CAP (5000) bounds the
      // read all the same, newest first, and anything past it is not
      // searched.
      const rows = await this.prisma.clientAttempt.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: ROW_CAP,
        select: ATTEMPT_SELECT,
      });
      const matched = rows.map(derive).filter((d) => {
        if (query.category && d.category !== query.category) return false;
        if (query.failureCode && d.failureCode !== query.failureCode) return false;
        if (needle !== "") {
          const texts = [d.row.reason ?? "", ...d.rungs.map((r) => r.result)];
          if (!texts.some((t) => t.toLowerCase().includes(needle))) return false;
        }
        return true;
      });
      total = matched.length;
      page = matched.slice(window.skip, window.skip + window.take);
    } else {
      const [count, rows] = await Promise.all([
        this.prisma.clientAttempt.count({ where }),
        this.prisma.clientAttempt.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: window.skip,
          take: window.take,
          select: ATTEMPT_SELECT,
        }),
      ]);
      total = count;
      page = rows.map(derive);
    }

    const described = await this.activity.describeAttempts(
      page.map((d) => d.row),
      now,
    );
    return {
      total,
      items: described.map((row, i) => {
        const d = page[i];
        return {
          ...row,
          receivedAt: d.row.createdAt.toISOString(),
          occurredAt: d.row.occurredAt?.toISOString() ?? null,
          category: d.category,
          failureCode: d.failureCode,
          apiEndpoint: d.row.apiEndpoint,
          apiTrace: parseApiTrace(d.row.apiEndpoint),
        };
      }),
    };
  }

  /** What the servers counted for the customer: per hour, as sessions,
   * and per day. */
  async usage(customerId: string, options: { hours?: string | number } = {}, now: number = Date.now()): Promise<CustomerUsage> {
    await this.mustExist(customerId);
    const hours = boundedInt(options.hours, 1, 336, 72);
    // `hours` whole UTC hours, the current one included.
    const since = new Date(Math.floor(now / HOUR_MS) * HOUR_MS - (hours - 1) * HOUR_MS).toISOString();

    // Both reads are bounded by reportedAt, which leads the
    // (subscriptionId, reportedAt) index -- there is none on periodStart.
    // A row's reportedAt is never before its periodStart, so the
    // periodStart bound selects exactly and the reportedAt one only lets
    // the index do the work. Times are TIMESTAMP(3) holding UTC, and the
    // bound is pinned to UTC as in the activity page's traffic.
    const [hourRows, periodRows, days] = await Promise.all([
      this.prisma.$queryRaw<{ hour: string; nodeId: string; protocol: string | null; up: string | null; down: string | null }[]>`
        SELECT to_char(date_trunc('hour', u."periodStart"), 'YYYY-MM-DD"T"HH24:00:00.000"Z"') AS "hour",
               u."nodeId" AS "nodeId",
               p."protocol"::text AS "protocol",
               SUM(u."bytesUp")::text AS "up",
               SUM(u."bytesDown")::text AS "down"
        FROM "usage_records" u
        LEFT JOIN "protocol_users" p ON p."id" = u."protocolUserId"
        WHERE u."subscriptionId" IN (SELECT "id" FROM "subscriptions" WHERE "customerId" = ${customerId})
          AND u."reportedAt" >= (${since}::timestamptz AT TIME ZONE 'UTC')
          AND u."periodStart" >= (${since}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY 1, 2, 3`,
      // Periods the device sent something in, folded per server, protocol
      // and minute: the nodes report every ~30 s, and the minute's span
      // is kept whole (its first start, its last end), so the 15-minute
      // gap rule reads them exactly as it would the rows.
      this.prisma.$queryRaw<{ nodeId: string; protocol: string | null; start: Date; end: Date; up: string; down: string }[]>`
        SELECT u."nodeId" AS "nodeId",
               p."protocol"::text AS "protocol",
               MIN(u."periodStart") AS "start",
               MAX(u."periodEnd") AS "end",
               SUM(u."bytesUp")::text AS "up",
               SUM(u."bytesDown")::text AS "down"
        FROM "usage_records" u
        LEFT JOIN "protocol_users" p ON p."id" = u."protocolUserId"
        WHERE u."subscriptionId" IN (SELECT "id" FROM "subscriptions" WHERE "customerId" = ${customerId})
          AND u."reportedAt" >= (${since}::timestamptz AT TIME ZONE 'UTC')
          AND u."periodStart" >= (${since}::timestamptz AT TIME ZONE 'UTC')
          AND u."bytesUp" > 0
        GROUP BY u."nodeId", p."protocol", date_trunc('minute', u."periodStart")
        ORDER BY 3 DESC
        LIMIT ${SESSION_PERIOD_CAP + 1}`,
      this.activity.trafficDays(customerId, USAGE_DAYS, now),
    ]);

    const nodeIds = [...new Set([...hourRows.map((r) => r.nodeId), ...periodRows.map((r) => r.nodeId)])];
    const nodes = nodeIds.length
      ? await this.prisma.node.findMany({ where: { id: { in: nodeIds } }, select: { id: true, name: true } })
      : [];
    const nodeName = new Map(nodes.map((n) => [n.id, n.name]));
    const nameOf = (id: string) => nodeName.get(id) ?? id;

    // Merged here as well as grouped there: two deleted credentials are
    // two NULL protocols in SQL and one "unknown" here.
    const merged = new Map<string, { hour: string; nodeName: string; protocol: string; up: bigint; down: bigint }>();
    for (const r of hourRows) {
      const name = nameOf(r.nodeId);
      const protocol = r.protocol ?? UNKNOWN_PROTOCOL;
      const key = `${r.hour}\u0000${name}\u0000${protocol}`;
      const e = merged.get(key) ?? { hour: r.hour, nodeName: name, protocol, up: 0n, down: 0n };
      e.up += BigInt(r.up ?? "0");
      e.down += BigInt(r.down ?? "0");
      merged.set(key, e);
    }
    const hourList: UsageHour[] = [...merged.values()]
      .sort((a, b) => a.hour.localeCompare(b.hour) || a.nodeName.localeCompare(b.nodeName) || a.protocol.localeCompare(b.protocol))
      .map((e) => ({ hour: e.hour, nodeName: e.nodeName, protocol: e.protocol, bytesUp: e.up.toString(), bytesDown: e.down.toString() }));

    const capped = periodRows.length > SESSION_PERIOD_CAP;
    const periods: UsagePeriod[] = periodRows.slice(0, SESSION_PERIOD_CAP).map((r) => ({
      nodeName: nameOf(r.nodeId),
      protocol: r.protocol ?? UNKNOWN_PROTOCOL,
      start: new Date(r.start).getTime(),
      end: new Date(r.end).getTime(),
      bytesUp: BigInt(r.up),
      bytesDown: BigInt(r.down),
    }));

    return { hours: hourList, sessions: buildSessions(periods), sessionsCapped: capped, days };
  }

  /** The account's story, newest first: each source read up to
   * HISTORY_SOURCE_CAP rows, merged, then paged. Staff actions only for a
   * SUPERADMIN, who alone may read the admin audit. */
  async history(
    customerId: string,
    query: { take?: string; skip?: string },
    caller: { role: AdminRole },
    now: number = Date.now(),
  ): Promise<Page<CustomerHistoryEvent>> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, createdAt: true, emailVerifiedAt: true, signupChannel: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    const window = listWindow(query, { defaultTake: 100, maxTake: 200 });
    const cap = HISTORY_SOURCE_CAP;

    const [identities, sessions, subscriptions, redemptions, payments, tickets, firstConnects] = await Promise.all([
      this.prisma.customerIdentity.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take: cap,
        select: { provider: true, createdAt: true },
      }),
      this.prisma.customerSession.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take: cap,
        select: { createdAt: true, revokedAt: true, platform: true, label: true, channel: true },
      }),
      this.prisma.subscription.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take: cap,
        select: { id: true, status: true, startAt: true, expireAt: true, plan: { select: { name: true } } },
      }),
      this.prisma.voucherRedemption.findMany({
        where: { customerId },
        orderBy: { redeemedAt: "desc" },
        take: cap,
        select: { redeemedAt: true, subscriptionId: true, voucher: { select: { plan: { select: { name: true } } } } },
      }),
      this.prisma.paymentTransaction.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take: cap,
        select: { createdAt: true, provider: true, status: true, amountUsd: true, currency: true },
      }),
      this.prisma.supportTicket.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take: cap,
        select: { id: true, createdAt: true, subject: true, status: true },
      }),
      // The earliest successes kept; the first that was a real connect
      // (not a config note) is the one shown.
      this.prisma.clientAttempt.findMany({
        where: { customerId, kind: ClientAttemptKind.CONNECT, outcome: ClientAttemptOutcome.SUCCESS },
        orderBy: { createdAt: "asc" },
        take: 50,
        select: ATTEMPT_SELECT,
      }),
    ]);

    const events: CustomerHistoryEvent[] = [];
    const push = (at: Date, type: CustomerHistoryEvent["type"], title: string, detail: string | null = null, actor: string | null = null, link: string | null = null) =>
      events.push({ at: at.toISOString(), type, title, detail, actor, link });

    push(customer.createdAt, "ACCOUNT_CREATED", "Account created", customer.signupChannel ? `Sign-up channel: ${customer.signupChannel}` : null);
    if (customer.emailVerifiedAt) push(customer.emailVerifiedAt, "EMAIL_VERIFIED", "Email verified");
    for (const i of identities) push(i.createdAt, "IDENTITY_LINKED", `${i.provider} sign-in linked`, i.provider);
    for (const s of sessions) {
      const device = [s.platform, s.label].filter(Boolean).join(", ") || "unknown device";
      push(s.createdAt, "DEVICE_SIGNED_IN", `Signed in on ${device}`, s.channel ? `Channel: ${s.channel}` : null);
      if (s.revokedAt) push(s.revokedAt, "DEVICE_SIGNED_OUT", `Signed out on ${device}`);
    }
    for (const s of subscriptions) {
      push(s.startAt, "SUBSCRIPTION_STARTED", `${s.plan.name} started`, `Status now: ${s.status}`);
      // Only a time the row holds: a past expiry date. A cancellation or
      // suspension records no time of its own, so it gets no event.
      if (s.status !== "PENDING" && s.expireAt.getTime() <= now) {
        push(s.expireAt, "SUBSCRIPTION_ENDED", `${s.plan.name} expiry date passed`, `Status now: ${s.status}`);
      }
    }
    for (const r of redemptions) push(r.redeemedAt, "CODE_REDEEMED", `Code redeemed for ${r.voucher.plan.name}`);
    for (const p of payments) {
      push(p.createdAt, "PAYMENT", `Payment ${p.status.toLowerCase()}`, `${p.provider}, ${p.amountUsd.toString()} USD (${p.currency}), ${p.status}`);
    }
    for (const t of tickets) push(t.createdAt, "SUPPORT_TICKET", `Support ticket: ${t.subject}`, `Status now: ${t.status}`, null, `/support/${t.id}`);
    const first = firstConnects.map(derive).find((d) => d.attempt);
    if (first) {
      push(new Date(first.at), "FIRST_CONNECT", "Earliest successful connect still kept", [first.row.protocol, first.row.platform, first.row.appVersion].filter(Boolean).join(", "));
    }

    if (caller.role === AdminRole.SUPERADMIN) {
      const ids = [customerId, ...subscriptions.slice(0, 50).map((s) => s.id)];
      const audit = await this.prisma.adminAuditEntry.findMany({
        where: { OR: ids.map((id) => ({ path: { contains: id } })) },
        orderBy: { createdAt: "desc" },
        take: cap,
        select: { createdAt: true, method: true, path: true, status: true, email: true, role: true },
      });
      for (const a of audit) {
        push(a.createdAt, "STAFF_ACTION", `${a.method} ${shortenIds(a.path)}`, `Status ${a.status}, ${a.role}`, a.email);
      }
    }

    events.sort((a, b) => b.at.localeCompare(a.at));
    return { total: events.length, items: events.slice(window.skip, window.skip + window.take) };
  }

  private async mustExist(customerId: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new NotFoundException("Customer not found");
  }
}
