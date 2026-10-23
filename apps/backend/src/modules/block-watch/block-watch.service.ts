import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BlockIncidentStatus,
  BlockVerdict,
  ClientAttemptKind,
  NodeStatus,
  Prisma,
  type BlockIncident,
} from "@prisma/client";
import { connect } from "node:net";
import { PrismaService } from "../../prisma/prisma.service";
import { HourlyBudget, PagerService, type PageDelivery } from "../alerting/pager.service";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import {
  assess,
  baselineDays,
  clientFamily,
  DAY,
  DEFAULT_TUNING,
  FAMILIES,
  parseTuning,
  probeFamily,
  recoveredFamilies,
  trafficFamily,
  type Assessment,
  type BlockTuning,
  type Family,
  type FamilyResult,
  type NodeDial,
  type ProbeCheck,
  type TrafficCounts,
} from "./block-signals";
import { HELD_FOR_BLOCK_WATCH, parseBlockWatchMode, type BlockWatchMode } from "./block-watch.mode";
import {
  digestPage,
  groupedPage,
  likelyBlockedPage,
  recoveriesPage,
  remindersPage,
  type IncidentView,
  type StoredEvidence,
} from "./block-watch.messages";

export { parseBlockWatchMode, type BlockWatchMode } from "./block-watch.mode";

/** Pages an hour, across all block incidents. One grouped page is one. */
export const PAGES_PER_HOUR = 4;
/** Of those, this many are kept for new likely blocks: reminders and
 * recovery notices only use what is left above it. */
export const RESERVED_FOR_NEW = 2;
/** This many servers starting to look blocked within the hour are told
 * as one event rather than one page each. */
export const GROUP_AT = 3;
export const REMIND_AFTER_MS = 24 * 3_600_000;
export const DIGEST_EVERY_MS = 24 * 3_600_000;
/** A cleared incident whose server looks blocked again within this is
 * opened again rather than a new one, and is not paged again. */
export const REOPEN_WITHIN_MS = 48 * 3_600_000;
/** Tries at a page that reaches nobody before it is left to the digest. */
export const MAX_PAGE_ATTEMPTS = 3;
const PROBE_LOOKBACK_MS = 12 * 3_600_000;
const CONTROL_TIMEOUT_MS = 5_000;
const MAX_SNOOZE_HOURS = 7 * 24;

export type BlockAction = "replaced" | "retired" | "keep" | "snooze";

export interface CycleSummary {
  nodeName: string;
  verdict: BlockVerdict | null;
  outage: string | null;
  firing: Family[];
}

/** Whether a TCP connection to host:port opens from here -- the server
 * this runs on, outside the watched country. The control that tells a
 * blocked server from a dead one. */
export function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** One row of latestDialsSql. */
interface LatestDialRow {
  customerId: string;
  asn: number;
  routeId: string;
  carried: boolean;
  happenedAt: Date;
  createdAt: Date;
  rung: number;
}

/** Each customer's latest dial of each route, per network, from the
 * connect reports that arrived since `sinceMs`, on the given networks
 * only. Deduplicated in the database, so however many reports one
 * account sends, it is one row per route -- it can neither crowd out
 * anyone else's nor count twice. Ordered by when the client says it
 * happened (never after arrival), then by its place in the ladder. */
export function latestDialsSql(sinceMs: number, asns: number[]): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT ON (a."customerId", a."asn", r.rung ->> 'routeId')
      a."customerId" AS "customerId",
      a."asn" AS "asn",
      r.rung ->> 'routeId' AS "routeId",
      (r.rung ->> 'carried')::boolean AS "carried",
      LEAST(COALESCE(a."occurredAt", a."createdAt"), a."createdAt") AS "happenedAt",
      a."createdAt" AS "createdAt",
      r.ord::int AS "rung"
    FROM "client_attempts" a
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(a."attemptsJson") = 'array' THEN a."attemptsJson" ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS r(rung, ord)
    WHERE a."createdAt" >= (to_timestamp(${sinceMs}::double precision / 1000) AT TIME ZONE 'UTC')
      AND a."kind" = 'CONNECT'
      AND a."customerId" IS NOT NULL
      AND a."asn" IN (${Prisma.join(asns)})
      AND jsonb_typeof(r.rung -> 'routeId') = 'string'
      AND jsonb_typeof(r.rung -> 'carried') = 'boolean'
    ORDER BY a."customerId", a."asn", r.rung ->> 'routeId',
      LEAST(COALESCE(a."occurredAt", a."createdAt"), a."createdAt") DESC, a."createdAt" DESC, r.ord DESC
  `;
}

/** A server this evaluation looks at, and what its windows hang on. */
interface Watched {
  node: { id: string; name: string; status: NodeStatus; publicIp: string; realityDestReachable: boolean | null };
  /** The owner's last answer that counts: nothing before it is evidence. */
  floor: number;
  open?: BlockIncident;
  /** A recently cleared incident this one would re-open. */
  reopenable?: BlockIncident;
  /** When the incident in hand began. While there is one, "before" means
   * before it, so a block that lasts never becomes the baseline. */
  anchor: number | null;
}

const FAMILY_WORDS: Record<Family, string> = {
  client: "networks that had failed carry again in the app reports",
  traffic: "traffic is back near usual",
  probe: "the probes connect again",
};

/**
 * Watches for servers that look blocked from the watched country, and
 * tells the owner. It never changes a server, buys anything or moves
 * anyone: what to do is the owner's, answered in the panel.
 *
 * Runs on the sweep cadence. Off unless BLOCK_WATCH says otherwise. Never
 * throws into its caller.
 */
@Injectable()
export class BlockWatchService {
  private readonly logger = new Logger(BlockWatchService.name);
  private readonly budget = new HourlyBudget(PAGES_PER_HOUR);
  private running: Promise<CycleSummary[]> | null = null;
  private lastCycleAt: Date | null = null;
  /** Also kept in memory, so a digest with nothing to stamp in the table
   * is still not sent again at the next evaluation. */
  private lastDigestAt: Date | null = null;
  private lastTuningRaw: string | null = null;
  /** Replaced in tests. */
  tcpReachable: (host: string, port: number, timeoutMs: number) => Promise<boolean> = tcpReachable;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly identity: NetworkIdentityService,
    private readonly pager: PagerService,
  ) {}

  get mode(): BlockWatchMode {
    return parseBlockWatchMode(this.config.get<string>("blockWatch.mode"));
  }

  private get country(): string {
    return (this.config.get<string>("reachability.country") ?? "ir").toLowerCase();
  }

  private get port(): number {
    return this.config.get<number>("reachability.port") ?? 443;
  }

  /** BLOCK_WATCH_TUNING, with anything unreadable left at its fallback
   * and said once in the log (names only, never the values in use). */
  private tuning(): BlockTuning {
    const raw = this.config.get<string>("blockWatch.tuning") ?? "";
    const { tuning, problems } = parseTuning(raw);
    if (raw !== this.lastTuningRaw) {
      this.lastTuningRaw = raw;
      for (const problem of problems) this.logger.warn(`BLOCK_WATCH_TUNING: ${problem}; using the fallback`);
    }
    return tuning;
  }

  /** One evaluation of every server, then whatever the mode sends. One at
   * a time: a manual run during the scheduled one waits for it. */
  runCycle(now: Date = new Date()): Promise<CycleSummary[]> {
    this.running ??= this.cycle(now)
      .catch((err) => {
        this.logger.error(`Block watch cycle failed: ${(err as Error).message}`);
        return [] as CycleSummary[];
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async cycle(now: Date): Promise<CycleSummary[]> {
    const mode = this.mode;
    if (mode === "off") return [];
    const tuning = this.tuning();
    const t = now.getTime();

    const nodes = await this.prisma.node.findMany({
      where: { status: { not: NodeStatus.PENDING } },
      select: { id: true, name: true, status: true, publicIp: true, realityDestReachable: true },
      orderBy: { name: "asc" },
    });
    const open = await this.prisma.blockIncident.findMany({
      where: { status: BlockIncidentStatus.OPEN, country: this.country },
    });
    const openByNode = new Map(open.map((i) => [i.nodeId, i]));
    const cleared = await this.prisma.blockIncident.findMany({
      where: { status: BlockIncidentStatus.CLEARED, country: this.country, closedAt: { gte: new Date(t - REOPEN_WITHIN_MS) } },
      orderBy: { closedAt: "desc" },
      distinct: ["nodeId"],
    });
    const clearedByNode = new Map(cleared.map((i) => [i.nodeId, i]));
    // The owner's latest answer per server.
    const marks = await this.prisma.blockIncident.findMany({
      where: { status: { in: [BlockIncidentStatus.REPLACED, BlockIncidentStatus.RETIRED] }, country: this.country },
      orderBy: { closedAt: "desc" },
      distinct: ["nodeId"],
      select: { nodeId: true, status: true, closedAt: true, publicIp: true },
    });
    const markByNode = new Map(marks.map((m) => [m.nodeId, m]));

    const watched: Watched[] = [];
    for (const node of nodes) {
      const mark = markByNode.get(node.id);
      const sameAddress = mark?.publicIp === node.publicIp;
      // A retired server is not watched while it keeps that address.
      if (mark?.status === BlockIncidentStatus.RETIRED && sameAddress) continue;
      // An answer wipes the slate only once the server has a new address:
      // until then the old evidence still describes this one.
      const floor = mark && !sameAddress ? (mark.closedAt?.getTime() ?? 0) : 0;
      const openIncident = openByNode.get(node.id);
      const recent = clearedByNode.get(node.id);
      const reopenable =
        !openIncident && recent && recent.publicIp === node.publicIp && (recent.closedAt?.getTime() ?? 0) >= floor
          ? recent
          : undefined;
      const anchor = (openIncident ?? reopenable)?.openedAt.getTime() ?? null;
      watched.push({ node, floor, open: openIncident, reopenable, anchor });
    }

    const [dials, checks] = await Promise.all([this.loadDials(t, tuning), this.loadChecks(t)]);
    const traffic = await this.loadTraffic(t, watched, tuning);
    const carried = await this.loadCarriedBefore(t, watched, dials, tuning);

    const summaries: CycleSummary[] = [];
    for (const w of watched) {
      const { node } = w;
      try {
        const incident = w.open ?? w.reopenable;
        const client = clientFamily(dials.get(node.id) ?? [], t, w.floor, carried.get(node.id) ?? new Set(), tuning, {
          failedAsns: incident?.failedAsns ?? [],
          orgOf: (asn) => this.identity.orgOf(asn),
        });
        const trafficResult = trafficFamily(
          trafficSince(traffic.get(node.id), t, w.floor, tuning, w.anchor === null ? undefined : firstDayOf(w.anchor, t, tuning)),
          tuning,
        );
        const probe = probeFamily(checks.get(node.id) ?? [], t, w.floor, tuning);
        const results = [client, trafficResult, probe];

        let outage: string | null = null;
        if (node.status !== NodeStatus.ONLINE) {
          outage = "its agent is offline (no heartbeat) -- an outage, not a block";
        } else if (node.realityDestReachable === false) {
          outage = "it reports its camouflage destination unreachable -- a fault on the server, not a block";
        } else if (
          results.some((f) => f.firing) &&
          !(await this.tcpReachable(node.publicIp, this.port, CONTROL_TIMEOUT_MS))
        ) {
          // Whatever fired, a port that is dead from abroad too is a dead
          // server or engine -- a crashed engine on a heartbeating agent
          // fails every report and empties the traffic just as a block does.
          outage = "its port does not answer from abroad either -- the server or its engine is down, not blocked";
        }

        const assessment = assess({
          client,
          traffic: trafficResult,
          probe,
          outage,
          previousSince: w.open ? sinceOf(w.open.evidenceJson) : {},
          now: t,
          tuning,
        });
        const evidence: StoredEvidence = {
          evaluatedAt: now.toISOString(),
          current: assessment.verdict,
          reason: assessment.reason,
          since: Object.fromEntries(
            Object.entries(assessment.since).map(([family, at]) => [family, new Date(at).toISOString()]),
          ),
          families: results,
          outage: assessment.outage,
          blockType: assessment.blockType,
          thinResidential: assessment.thinResidential,
          country: this.country,
          clearing: null,
        };
        await this.reconcile(w, assessment, results, evidence, now, tuning);
        summaries.push({
          nodeName: node.name,
          verdict: assessment.verdict,
          outage: assessment.outage,
          firing: results.filter((f) => f.firing).map((f) => f.family),
        });
      } catch (err) {
        // One server's failure must not abandon the rest.
        this.logger.error(`Block watch failed for ${node.name}: ${(err as Error).message}`);
      }
    }

    if (mode === "notify") await this.page(now);
    if (mode === "notify" || mode === "digest") await this.digest(mode, now);
    this.lastCycleAt = now;
    return summaries;
  }

  private async reconcile(
    w: Watched,
    assessment: Assessment,
    results: FamilyResult[],
    evidence: StoredEvidence,
    now: Date,
    tuning: BlockTuning,
  ): Promise<void> {
    const { node, open, reopenable } = w;
    const json = () => evidence as unknown as Prisma.InputJsonValue;
    if (assessment.outage) {
      // Neither a block nor its end: an open incident waits it out.
      if (open) await this.prisma.blockIncident.update({ where: { id: open.id }, data: { evidenceJson: json() } });
      return;
    }

    const firing = results.filter((r) => r.firing).map((r) => r.family);
    const failingAsns = (results.find((r) => r.family === "client")?.networks ?? [])
      .filter((n) => n.failing)
      .map((n) => n.asn);
    if (assessment.verdict) {
      const verdict: BlockVerdict = assessment.verdict;
      const likely = verdict === BlockVerdict.LIKELY_BLOCKED;
      const base = open ?? reopenable;
      if (base) {
        await this.prisma.blockIncident.update({
          where: { id: base.id },
          data: {
            // Back within the window: the same incident, opened again. Its
            // page, if it had one, stands; the digest says it came back.
            ...(open ? {} : { status: BlockIncidentStatus.OPEN, closedAt: null, reopenedAt: now }),
            // The strongest verdict reached stays; the latest is in the evidence.
            verdict: base.verdict === BlockVerdict.LIKELY_BLOCKED ? base.verdict : verdict,
            likelyAt: base.likelyAt ?? (likely ? now : null),
            lastSeenAt: now,
            quietCycles: 0,
            firedFamilies: union(base.firedFamilies, firing),
            failedAsns: union(base.failedAsns, failingAsns),
            evidenceJson: json(),
          },
        });
        return;
      }
      await this.prisma.blockIncident.create({
        data: {
          nodeId: node.id,
          publicIp: node.publicIp,
          country: this.country,
          verdict,
          openedAt: now,
          lastSeenAt: now,
          likelyAt: likely ? now : null,
          firedFamilies: firing,
          failedAsns: failingAsns,
          evidenceJson: json(),
        },
      });
      return;
    }
    if (!open) return;

    // Nothing fires. That alone proves nothing -- a signal also stops when
    // its data runs thin -- so the incident clears only when a signal that
    // fired shows the server working again, a few evaluations running.
    const fired = (open.firedFamilies.length ? open.firedFamilies : FAMILIES).filter(isFamily);
    const firedResults = results.filter((r) => fired.includes(r.family));
    const recovered = recoveredFamilies(fired, results);
    // "Keep" is the owner's word that it is fine: with nothing to say
    // otherwise, it is allowed to close.
    const vouched = open.keptAt !== null && firedResults.every((r) => r.thin);
    if (recovered.length === 0 && !vouched) {
      evidence.clearing = firedResults.every((r) => r.thin)
        ? `held open: the signals that fired (${fired.join(", ")}) have too little data to say whether it works again`
        : `held open: no sign yet that it works again (${fired.join(", ")} not back to normal)`;
      await this.prisma.blockIncident.update({ where: { id: open.id }, data: { quietCycles: 0, evidenceJson: json() } });
      return;
    }
    const quietCycles = open.quietCycles + 1;
    const clears = quietCycles >= tuning.quietCyclesToClear;
    evidence.clearing = recovered.length
      ? `shown working again: ${recovered.map((f) => FAMILY_WORDS[f]).join("; ")}${clears ? "" : " (it clears if that holds)"}`
      : "kept by the owner, and the signals that fired have no data either way";
    await this.prisma.blockIncident.update({
      where: { id: open.id },
      data: {
        quietCycles,
        evidenceJson: json(),
        ...(clears ? { status: BlockIncidentStatus.CLEARED, closedAt: now } : {}),
      },
    });
  }

  /** Pages, reminders and recovery notices, within the hourly budget.
   * Anything over it waits for the next evaluation rather than being
   * dropped. New likely blocks come first and have budget kept for them;
   * reminders and recovery notices are one message each per evaluation. */
  private async page(now: Date): Promise<void> {
    const t = now.getTime();
    const include = { node: { select: { name: true } } } as const;
    const quiet = (i: BlockIncident) => i.keptAt !== null || (i.snoozedUntil !== null && i.snoozedUntil.getTime() > t);

    const due = (
      await this.prisma.blockIncident.findMany({
        where: {
          status: BlockIncidentStatus.OPEN,
          verdict: BlockVerdict.LIKELY_BLOCKED,
          pagedAt: null,
          pageAttempts: { lt: MAX_PAGE_ATTEMPTS },
          country: this.country,
        },
        include,
        orderBy: { openedAt: "asc" },
      })
    )
      // Paged only while the latest evaluation says likely: an incident
      // that touched it once and fell back is a suspicion now.
      .filter((i) => !quiet(i) && evidenceOf(i)?.current === BlockVerdict.LIKELY_BLOCKED);

    if (due.length) {
      const pagedThisHour = await this.prisma.blockIncident.count({
        where: { country: this.country, pagedAt: { gte: new Date(t - 3_600_000) } },
      });
      if (due.length + pagedThisHour >= GROUP_AT) {
        if (this.budget.take(t)) {
          const delivery = await this.pager.page(groupedPage(due.map(view), pagedThisHour, now));
          for (const incident of due) await this.recordPage(incident, delivery, now);
        }
      } else {
        for (const incident of due) {
          if (!this.budget.take(t)) break;
          const delivery = await this.pager.page(likelyBlockedPage(view(incident), now));
          await this.recordPage(incident, delivery, now);
        }
      }
    }

    const stale = (
      await this.prisma.blockIncident.findMany({
        where: {
          status: BlockIncidentStatus.OPEN,
          country: this.country,
          pagedAt: { lte: new Date(t - REMIND_AFTER_MS) },
          remindedAt: null,
        },
        include,
        orderBy: { openedAt: "asc" },
      })
    ).filter((i) => !quiet(i));
    if (stale.length && this.takeSpare(t)) {
      const delivery = await this.pager.page(remindersPage(stale.map(view), now));
      if (delivery.error) this.logger.warn(`Block-watch reminder: ${delivery.error}`);
      await this.prisma.blockIncident.updateMany({ where: { id: { in: stale.map((i) => i.id) } }, data: { remindedAt: now } });
    }

    const recovered = await this.prisma.blockIncident.findMany({
      where: {
        status: BlockIncidentStatus.CLEARED,
        country: this.country,
        pagedAt: { not: null },
        recoveryNotifiedAt: null,
      },
      include,
      orderBy: { closedAt: "asc" },
    });
    // The owner already said these were fine: their end is not news.
    const kept = recovered.filter((i) => i.keptAt !== null);
    if (kept.length) {
      await this.prisma.blockIncident.updateMany({
        where: { id: { in: kept.map((i) => i.id) } },
        data: { recoveryNotifiedAt: now },
      });
    }
    const news = recovered.filter((i) => i.keptAt === null);
    if (news.length && this.takeSpare(t)) {
      const delivery = await this.pager.page(
        recoveriesPage(
          news.map((i) => ({ ...view(i), closedAt: i.closedAt ?? now })),
          now,
        ),
      );
      if (delivery.error) this.logger.warn(`Block-watch recovery notice: ${delivery.error}`);
      await this.prisma.blockIncident.updateMany({
        where: { id: { in: news.map((i) => i.id) } },
        data: { recoveryNotifiedAt: now },
      });
    }
  }

  /** One page from the budget above what is kept for new likely blocks. */
  private takeSpare(t: number): boolean {
    return this.budget.left(t) > RESERVED_FOR_NEW && this.budget.take(t);
  }

  /** A page counts as sent only once it reached somebody. Until then the
   * incident is tried again on later evaluations, up to MAX_PAGE_ATTEMPTS,
   * and after that it is listed in the daily digest. */
  private async recordPage(incident: BlockIncident, delivery: PageDelivery, now: Date): Promise<void> {
    await this.prisma.blockIncident.update({
      where: { id: incident.id },
      data: {
        ...(delivery.delivered ? { pagedAt: now } : {}),
        pageError: delivery.error ?? (delivery.delivered ? null : "it reached nobody"),
        pageAttempts: incident.pageAttempts + 1,
      },
    });
  }

  /** At most one a day, and only when there is something in it. In notify
   * mode it carries the suspects (likely blocks were paged), pages that
   * reached nobody, incidents that came back, and reachability alerts held
   * for an open incident; in digest mode, everything open. */
  private async digest(mode: BlockWatchMode, now: Date): Promise<void> {
    const t = now.getTime();
    const stored = (
      await this.prisma.blockIncident.aggregate({ where: { country: this.country }, _max: { digestedAt: true } })
    )._max.digestedAt;
    const last = [stored, this.lastDigestAt].reduce<Date | null>(
      (latest, d) => (d && (!latest || d > latest) ? d : latest),
      null,
    );
    if (last && t - last.getTime() < DIGEST_EVERY_MS) return;
    const since = last ?? new Date(t - DIGEST_EVERY_MS);
    const notify = mode === "notify";

    const include = { node: { select: { name: true } } } as const;
    const allOpen = await this.prisma.blockIncident.findMany({
      where: { status: BlockIncidentStatus.OPEN, country: this.country },
      include,
      orderBy: { openedAt: "asc" },
    });
    const undelivered = notify
      ? allOpen.filter(
          (i) => i.verdict === BlockVerdict.LIKELY_BLOCKED && i.pagedAt === null && i.pageAttempts >= MAX_PAGE_ATTEMPTS,
        )
      : [];
    const reopened = allOpen.filter(
      (i) => i.reopenedAt !== null && i.reopenedAt >= since && !undelivered.includes(i),
    );
    const listed = new Set([...undelivered, ...reopened].map((i) => i.id));
    const open = allOpen.filter((i) => !listed.has(i.id) && (!notify || i.verdict === BlockVerdict.SUSPECT));
    const cleared = await this.prisma.blockIncident.findMany({
      where: {
        status: BlockIncidentStatus.CLEARED,
        country: this.country,
        closedAt: { gte: since },
        // In notify mode a paged incident's end was paged too.
        ...(notify ? { pagedAt: null } : {}),
      },
      include,
    });
    const held = notify
      ? await this.prisma.nodeReachabilityAlert.findMany({
          where: { notifyError: HELD_FOR_BLOCK_WATCH, openedAt: { gte: since } },
          select: { node: { select: { name: true } } },
        })
      : [];
    const heldProbeAlerts = [...new Set(held.map((a) => a.node.name))];
    if (!open.length && !cleared.length && !undelivered.length && !reopened.length && !heldProbeAlerts.length) return;

    const delivery = await this.pager.page(
      digestPage(
        {
          open: open.map(view),
          cleared: cleared.map((i) => ({ ...view(i), closedAt: i.closedAt ?? now })),
          undelivered: undelivered.map((i) => ({ ...view(i), pageError: i.pageError })),
          reopened: reopened.map(view),
          heldProbeAlerts,
          calibrating: mode === "digest",
          country: this.country,
        },
        now,
      ),
    );
    if (delivery.error) this.logger.warn(`Block-watch digest: ${delivery.error}`);
    this.lastDigestAt = now;
    await this.prisma.blockIncident.updateMany({
      where: { id: { in: [...allOpen, ...cleared].map((i) => i.id) } },
      data: { digestedAt: now },
    });
  }

  /** The panel's view: the mode, what is open, and what closed lately.
   * Never the address. */
  async overview(now: Date = new Date()) {
    const select = {
      id: true,
      nodeId: true,
      status: true,
      verdict: true,
      openedAt: true,
      lastSeenAt: true,
      likelyAt: true,
      closedAt: true,
      reopenedAt: true,
      evidenceJson: true,
      pagedAt: true,
      pageError: true,
      pageAttempts: true,
      remindedAt: true,
      recoveryNotifiedAt: true,
      keptAt: true,
      snoozedUntil: true,
      actedBy: true,
      actionNote: true,
      node: { select: { name: true, region: true, status: true } },
    } as const;
    const [open, closed] = await Promise.all([
      this.prisma.blockIncident.findMany({
        where: { status: BlockIncidentStatus.OPEN },
        select,
        orderBy: [{ verdict: "desc" }, { openedAt: "asc" }],
      }),
      this.prisma.blockIncident.findMany({
        where: { status: { not: BlockIncidentStatus.OPEN }, closedAt: { gte: new Date(now.getTime() - 14 * 86_400_000) } },
        select,
        orderBy: { closedAt: "desc" },
        take: 50,
      }),
    ]);
    return { mode: this.mode, country: this.country, lastCycleAt: this.lastCycleAt, open, closed };
  }

  /** The owner's answer to an incident. Records it; changes no server. */
  async act(
    id: string,
    action: BlockAction,
    by: string,
    opts: { hours?: number; note?: string } = {},
    now: Date = new Date(),
  ) {
    const incident = await this.prisma.blockIncident.findUnique({
      where: { id },
      select: { id: true, status: true, publicIp: true, node: { select: { publicIp: true } } },
    });
    if (!incident) throw new NotFoundException("No such incident");
    if (incident.status !== BlockIncidentStatus.OPEN) throw new BadRequestException("This incident is already closed");
    const common = { actedBy: by, actionNote: opts.note?.trim() || null };
    let data: Prisma.BlockIncidentUpdateInput;
    switch (action) {
      case "replaced":
        // Replacing wipes the slate for the server. Before it has a new
        // address that would only blind the watch to a block still there.
        if (incident.node.publicIp === incident.publicIp) {
          throw new BadRequestException(
            "The server still has the address it had when this opened. Mark it replaced once it has its new address; until then, snooze it.",
          );
        }
        data = { ...common, status: BlockIncidentStatus.REPLACED, closedAt: now };
        break;
      case "retired":
        data = { ...common, status: BlockIncidentStatus.RETIRED, closedAt: now };
        break;
      case "keep":
        data = { ...common, keptAt: now };
        break;
      case "snooze": {
        const hours = opts.hours ?? 24;
        if (!Number.isInteger(hours) || hours < 1 || hours > MAX_SNOOZE_HOURS) {
          throw new BadRequestException(`Snooze for 1 to ${MAX_SNOOZE_HOURS} hours`);
        }
        data = { ...common, snoozedUntil: new Date(now.getTime() + hours * 3_600_000) };
        break;
      }
      default:
        throw new BadRequestException("Unknown action");
    }
    return this.prisma.blockIncident.update({ where: { id }, data, select: { id: true, status: true } });
  }

  /** Each signed-in customer's latest dial of each direct route, from
   * recent connect reports on networks registered in the watched country,
   * by server. The network filter and the one-row-per-customer-and-route
   * are done in the database (latestDialsSql), so the volume of anyone's
   * reports changes nothing. */
  private async loadDials(now: number, tuning: BlockTuning): Promise<Map<string, NodeDial[]>> {
    const since = now - tuning.recentWindow;
    const networks = await this.prisma.clientAttempt.groupBy({
      by: ["asn"],
      where: {
        kind: ClientAttemptKind.CONNECT,
        customerId: { not: null },
        asn: { not: null },
        createdAt: { gte: new Date(since) },
      },
    });
    const watched = networks
      .map((n) => n.asn)
      .filter((asn): asn is number => asn !== null && this.identity.countryOfAsn(asn)?.toLowerCase() === this.country);
    if (watched.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<LatestDialRow[]>(latestDialsSql(since, watched));
    const routes = await this.prisma.route.findMany({
      where: { exitProtocolConfigId: null },
      select: { id: true, entryProtocolConfig: { select: { nodeId: true, protocol: true } } },
    });
    const routeNode = new Map(routes.map((r) => [r.id, r.entryProtocolConfig]));

    const byNode = new Map<string, NodeDial[]>();
    for (const row of rows) {
      const entry = routeNode.get(row.routeId);
      if (!entry) continue;
      const list = byNode.get(entry.nodeId) ?? [];
      list.push({
        customerId: row.customerId,
        asn: Number(row.asn),
        carried: row.carried,
        at: new Date(row.happenedAt).getTime(),
        arrived: new Date(row.createdAt).getTime(),
        protocol: entry.protocol,
        rung: Number(row.rung),
      });
      byNode.set(entry.nodeId, list);
    }
    return byNode;
  }

  /** Of the customers dialling each server, those it carried traffic for
   * before -- measured by the server (usage records), not claimed by the
   * apps. "Before" ends where the open incident began, if there is one. */
  private async loadCarriedBefore(
    now: number,
    watched: Watched[],
    dials: Map<string, NodeDial[]>,
    tuning: BlockTuning,
  ): Promise<Map<string, Set<string>>> {
    const windows = new Map<string, { start: number; end: number; nodeIds: string[] }>();
    const dialling = new Map<string, Set<string>>();
    for (const w of watched) {
      const list = dials.get(w.node.id);
      if (!list?.length) continue;
      const end = Math.min(now - tuning.recentWindow, w.anchor ?? Number.POSITIVE_INFINITY);
      const start = Math.max(end - tuning.baselineWindow, w.floor);
      if (start >= end) continue;
      const key = `${start}:${end}`;
      const window = windows.get(key) ?? { start, end, nodeIds: [] };
      window.nodeIds.push(w.node.id);
      windows.set(key, window);
      dialling.set(w.node.id, new Set(list.map((d) => d.customerId)));
    }
    const out = new Map<string, Set<string>>();
    if (windows.size === 0) return out;
    const customers = [...new Set([...dialling.values()].flatMap((set) => [...set]))];
    const subscriptions = await this.prisma.subscription.findMany({
      where: { customerId: { in: customers } },
      select: { id: true, customerId: true },
    });
    if (subscriptions.length === 0) return out;
    const customerOf = new Map(subscriptions.map((s) => [s.id, s.customerId]));

    for (const { start, end, nodeIds } of windows.values()) {
      const groups = await this.prisma.usageRecord.groupBy({
        by: ["nodeId", "subscriptionId"],
        where: {
          nodeId: { in: nodeIds },
          subscriptionId: { in: [...customerOf.keys()] },
          reportedAt: { gte: new Date(start), lt: new Date(end) },
        },
        _sum: { bytesUp: true },
        having: { bytesUp: { _sum: { gte: tuning.upstreamActiveBytes } } },
      });
      for (const group of groups) {
        const customer = customerOf.get(group.subscriptionId);
        if (!customer || !dialling.get(group.nodeId)?.has(customer)) continue;
        const set = out.get(group.nodeId) ?? new Set<string>();
        set.add(customer);
        out.set(group.nodeId, set);
      }
    }
    return out;
  }

  /** The reachability monitor's recent checks, newest first, by server. */
  private async loadChecks(now: number): Promise<Map<string, ProbeCheck[]>> {
    const rows = await this.prisma.nodeReachabilityCheck.findMany({
      where: { country: this.country, checkedAt: { gte: new Date(now - PROBE_LOOKBACK_MS) } },
      select: { nodeId: true, verdict: true, checkedAt: true, detailJson: true },
      orderBy: { checkedAt: "desc" },
    });
    const byNode = new Map<string, ProbeCheck[]>();
    for (const row of rows) {
      const list = byNode.get(row.nodeId) ?? [];
      list.push({ verdict: row.verdict, checkedAt: row.checkedAt.getTime(), detail: row.detailJson });
      byNode.set(row.nodeId, list);
    }
    return byNode;
  }

  /** People who sent at least a little upstream through each server, in
   * the last window (day 0) and in the same window on the earlier days
   * each server is compared against -- for one with an incident, the days
   * before it began. One grouped query per day offset, limited to the
   * servers that need it, so the (nodeId, reportedAt) index answers it. */
  private async loadTraffic(
    now: number,
    watched: Watched[],
    tuning: BlockTuning,
  ): Promise<Map<string, Map<number, number>>> {
    const days = baselineDays(tuning);
    const byOffset = new Map<number, string[]>();
    const want = (offset: number, nodeId: string) => {
      const list = byOffset.get(offset) ?? [];
      list.push(nodeId);
      byOffset.set(offset, list);
    };
    for (const w of watched) {
      want(0, w.node.id);
      const first = w.anchor === null ? 1 : firstDayOf(w.anchor, now, tuning);
      for (let day = first; day < first + days; day += 1) want(day, w.node.id);
    }
    const byNode = new Map<string, Map<number, number>>();
    for (const [day, nodeIds] of byOffset) {
      const end = now - day * DAY;
      const groups = await this.prisma.usageRecord.groupBy({
        by: ["nodeId", "subscriptionId"],
        where: {
          nodeId: { in: nodeIds },
          reportedAt: { gte: new Date(end - tuning.trafficWindow), lt: new Date(end) },
        },
        _sum: { bytesUp: true },
        having: { bytesUp: { _sum: { gte: tuning.upstreamActiveBytes } } },
      });
      for (const group of groups) {
        const counts = byNode.get(group.nodeId) ?? new Map<number, number>();
        counts.set(day, (counts.get(day) ?? 0) + 1);
        byNode.set(group.nodeId, counts);
      }
    }
    return byNode;
  }
}

/** The first earlier day to compare against while an incident that
 * began at `anchor` is open: the first whose window ends before it by a
 * margin, since the block was already there for a while before the
 * evidence for it was enough to open one. */
export function firstDayOf(anchor: number, now: number, tuning: BlockTuning = DEFAULT_TUNING): number {
  const margin = Math.max(tuning.trafficWindow, tuning.recentWindow);
  return Math.max(1, Math.ceil((now - anchor + margin) / DAY));
}

/** A server's traffic counts: now, and the earlier days compared against
 * -- from `firstDay` (set while an incident is open: the days before it
 * began), the days before `floor` (the owner's last answer) left out as
 * not comparable. */
export function trafficSince(
  counts: Map<number, number> | undefined,
  now: number,
  floor: number,
  tuning: BlockTuning = DEFAULT_TUNING,
  firstDay?: number,
): TrafficCounts {
  const first = firstDay ?? 1;
  const baseline: (number | null)[] = [];
  for (let day = first; day < first + baselineDays(tuning); day += 1) {
    const start = now - day * DAY - tuning.trafficWindow;
    baseline.push(start < floor ? null : (counts?.get(day) ?? 0));
  }
  return { current: counts?.get(0) ?? 0, baseline, beforeIncident: firstDay !== undefined };
}

/** The per-family start times kept on an open incident. */
export function sinceOf(evidence: Prisma.JsonValue): Partial<Record<Family, number>> {
  const since = (evidence as { since?: Record<string, unknown> } | null)?.since;
  const out: Partial<Record<Family, number>> = {};
  if (!since || typeof since !== "object") return out;
  for (const family of FAMILIES) {
    const value = since[family];
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(ms)) out[family] = ms;
  }
  return out;
}

function isFamily(value: string): value is Family {
  return (FAMILIES as readonly string[]).includes(value);
}

function union<T>(a: readonly T[], b: readonly T[]): T[] {
  return [...new Set([...a, ...b])];
}

function evidenceOf(i: BlockIncident): StoredEvidence | null {
  return (i.evidenceJson as unknown as StoredEvidence | null) ?? null;
}

function view(i: BlockIncident & { node: { name: string } }): IncidentView {
  return { nodeName: i.node.name, openedAt: i.openedAt, evidence: i.evidenceJson as unknown as StoredEvidence };
}
