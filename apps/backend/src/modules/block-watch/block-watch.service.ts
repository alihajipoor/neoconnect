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
import { dialsOf, happenedAt } from "../isp-recommendations/isp-signal";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import {
  assess,
  BASELINE_MS,
  clientFamily,
  FAMILIES,
  probeFamily,
  QUIET_CYCLES_TO_CLEAR,
  TRAFFIC_WINDOW_MS,
  trafficFamily,
  UPSTREAM_ACTIVE_BYTES,
  type Family,
  type NodeDial,
  type ProbeCheck,
  type TrafficCounts,
} from "./block-signals";
import {
  digestPage,
  groupedPage,
  likelyBlockedPage,
  recoveryPage,
  reminderPage,
  type IncidentView,
  type StoredEvidence,
} from "./block-watch.messages";

/** off: nothing runs. record: verdicts are kept and shown in the panel,
 * nothing is sent. digest: also a daily digest, no pages (the calibration
 * stage). notify: pages for LIKELY_BLOCKED, the digest for the rest. */
export type BlockWatchMode = "off" | "record" | "digest" | "notify";
const MODES: readonly BlockWatchMode[] = ["off", "record", "digest", "notify"];

/** BLOCK_WATCH, read leniently: anything unrecognised is off. */
export function parseBlockWatchMode(raw: string | undefined | null): BlockWatchMode {
  const value = (raw ?? "").trim().toLowerCase() as BlockWatchMode;
  return MODES.includes(value) ? value : "off";
}

/** Pages an hour, across all block incidents. One grouped page is one. */
export const PAGES_PER_HOUR = 4;
/** This many servers starting to look blocked within the hour are told
 * as one event rather than one page each. */
export const GROUP_AT = 3;
export const REMIND_AFTER_MS = 24 * 3_600_000;
export const DIGEST_EVERY_MS = 24 * 3_600_000;
const PROBE_LOOKBACK_MS = 12 * 3_600_000;
/** Bounds the report scan: a week of connect reports is a few thousand
 * rows today. */
const MAX_REPORT_ROWS = 50_000;
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
    // The owner's latest answer per server: evidence from before it does
    // not count, and a retired server is not watched while its address is
    // the one it was retired with.
    const marks = await this.prisma.blockIncident.findMany({
      where: { status: { in: [BlockIncidentStatus.REPLACED, BlockIncidentStatus.RETIRED] }, country: this.country },
      orderBy: { closedAt: "desc" },
      distinct: ["nodeId"],
      select: { nodeId: true, status: true, closedAt: true, publicIp: true },
    });
    const markByNode = new Map(marks.map((m) => [m.nodeId, m]));

    const [dials, checks, traffic] = await Promise.all([this.loadDials(t), this.loadChecks(t), this.loadTraffic(t)]);

    const summaries: CycleSummary[] = [];
    for (const node of nodes) {
      try {
        const mark = markByNode.get(node.id);
        if (mark?.status === BlockIncidentStatus.RETIRED && mark.publicIp === node.publicIp) continue;
        const floor = mark?.closedAt?.getTime() ?? 0;

        const client = clientFamily(dials.get(node.id) ?? [], t, floor, (asn) => this.identity.orgOf(asn));
        const trafficResult = trafficFamily(trafficSince(traffic.get(node.id), t, floor));
        const probe = probeFamily(checks.get(node.id) ?? [], t, floor);

        let outage: string | null = null;
        if (node.status !== NodeStatus.ONLINE) {
          outage = "its agent is offline (no heartbeat) -- an outage, not a block";
        } else if (node.realityDestReachable === false) {
          outage = "it reports its camouflage destination unreachable -- a fault on the server, not a block";
        } else if (probe.firing && !(await this.tcpReachable(node.publicIp, this.port, CONTROL_TIMEOUT_MS))) {
          outage = "its port does not answer from abroad either -- the server or its engine is down, not blocked";
        }

        const previous = openByNode.get(node.id);
        const assessment = assess({
          client,
          traffic: trafficResult,
          probe,
          outage,
          previousSince: previous ? sinceOf(previous.evidenceJson) : {},
          now: t,
        });
        const evidence: StoredEvidence = {
          evaluatedAt: now.toISOString(),
          current: assessment.verdict,
          reason: assessment.reason,
          since: Object.fromEntries(
            Object.entries(assessment.since).map(([family, at]) => [family, new Date(at).toISOString()]),
          ),
          families: [client, trafficResult, probe],
          outage: assessment.outage,
          blockType: assessment.blockType,
          thinResidential: assessment.thinResidential,
          country: this.country,
        };
        await this.reconcile(node, previous, assessment.verdict, assessment.outage, evidence, now);
        summaries.push({
          nodeName: node.name,
          verdict: assessment.verdict,
          outage: assessment.outage,
          firing: [client, trafficResult, probe].filter((f) => f.firing).map((f) => f.family),
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
    node: { id: string; publicIp: string },
    open: BlockIncident | undefined,
    verdict: string | null,
    outage: string | null,
    evidence: StoredEvidence,
    now: Date,
  ): Promise<void> {
    const evidenceJson = evidence as unknown as Prisma.InputJsonValue;
    if (outage) {
      // Neither a block nor its end: an open incident waits it out.
      if (open) await this.prisma.blockIncident.update({ where: { id: open.id }, data: { evidenceJson } });
      return;
    }
    if (verdict) {
      const likely = verdict === BlockVerdict.LIKELY_BLOCKED;
      if (!open) {
        await this.prisma.blockIncident.create({
          data: {
            nodeId: node.id,
            publicIp: node.publicIp,
            country: this.country,
            verdict: verdict as BlockVerdict,
            openedAt: now,
            lastSeenAt: now,
            likelyAt: likely ? now : null,
            evidenceJson,
          },
        });
        return;
      }
      await this.prisma.blockIncident.update({
        where: { id: open.id },
        data: {
          // The strongest verdict reached stays; the latest is in the evidence.
          verdict: open.verdict === BlockVerdict.LIKELY_BLOCKED ? open.verdict : (verdict as BlockVerdict),
          likelyAt: open.likelyAt ?? (likely ? now : null),
          lastSeenAt: now,
          quietCycles: 0,
          evidenceJson,
        },
      });
      return;
    }
    if (!open) return;
    const quietCycles = open.quietCycles + 1;
    const clears = quietCycles >= QUIET_CYCLES_TO_CLEAR;
    await this.prisma.blockIncident.update({
      where: { id: open.id },
      data: {
        quietCycles,
        evidenceJson,
        ...(clears ? { status: BlockIncidentStatus.CLEARED, closedAt: now } : {}),
      },
    });
  }

  /** Pages, reminders and recoveries, within the hourly budget. Anything
   * over it waits for the next cycle rather than being dropped. */
  private async page(now: Date): Promise<void> {
    const t = now.getTime();
    const include = { node: { select: { name: true } } } as const;
    const quiet = (i: BlockIncident) => i.keptAt !== null || (i.snoozedUntil !== null && i.snoozedUntil.getTime() > t);

    const due = (
      await this.prisma.blockIncident.findMany({
        where: { status: BlockIncidentStatus.OPEN, verdict: BlockVerdict.LIKELY_BLOCKED, pagedAt: null, country: this.country },
        include,
        orderBy: { openedAt: "asc" },
      })
    ).filter((i) => !quiet(i));

    if (due.length) {
      const pagedThisHour = await this.prisma.blockIncident.count({
        where: { country: this.country, pagedAt: { gte: new Date(t - 3_600_000) } },
      });
      if (due.length + pagedThisHour >= GROUP_AT) {
        if (this.budget.take(t)) {
          const delivery = await this.pager.page(groupedPage(due.map(view), pagedThisHour, now));
          for (const incident of due) await this.recordPage(incident.id, delivery, now);
        }
      } else {
        for (const incident of due) {
          if (!this.budget.take(t)) break;
          const delivery = await this.pager.page(likelyBlockedPage(view(incident), now));
          await this.recordPage(incident.id, delivery, now);
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
      })
    ).filter((i) => !quiet(i));
    for (const incident of stale) {
      if (!this.budget.take(t)) break;
      await this.pager.page(reminderPage(view(incident), now));
      await this.prisma.blockIncident.update({ where: { id: incident.id }, data: { remindedAt: now } });
    }

    const recovered = await this.prisma.blockIncident.findMany({
      where: {
        status: BlockIncidentStatus.CLEARED,
        country: this.country,
        pagedAt: { not: null },
        recoveryNotifiedAt: null,
      },
      include,
    });
    for (const incident of recovered) {
      if (!this.budget.take(t)) break;
      await this.pager.page(recoveryPage({ ...view(incident), closedAt: incident.closedAt ?? now }, now));
      await this.prisma.blockIncident.update({ where: { id: incident.id }, data: { recoveryNotifiedAt: now } });
    }
  }

  private async recordPage(id: string, delivery: PageDelivery, now: Date): Promise<void> {
    await this.prisma.blockIncident.update({ where: { id }, data: { pagedAt: now, pageError: delivery.error } });
  }

  /** At most one a day, and only when there is something in it. In notify
   * mode it carries the suspects (likely blocks were paged); in digest
   * mode, everything. */
  private async digest(mode: BlockWatchMode, now: Date): Promise<void> {
    const t = now.getTime();
    const last = (
      await this.prisma.blockIncident.aggregate({ where: { country: this.country }, _max: { digestedAt: true } })
    )._max.digestedAt;
    if (last && t - last.getTime() < DIGEST_EVERY_MS) return;

    const include = { node: { select: { name: true } } } as const;
    const open = await this.prisma.blockIncident.findMany({
      where: {
        status: BlockIncidentStatus.OPEN,
        country: this.country,
        ...(mode === "notify" ? { verdict: BlockVerdict.SUSPECT } : {}),
      },
      include,
      orderBy: { openedAt: "asc" },
    });
    const cleared = await this.prisma.blockIncident.findMany({
      where: {
        status: BlockIncidentStatus.CLEARED,
        country: this.country,
        digestedAt: null,
        closedAt: { gte: last ?? new Date(t - DIGEST_EVERY_MS) },
        // In notify mode a paged incident's end was paged too.
        ...(mode === "notify" ? { pagedAt: null } : {}),
      },
      include,
    });
    if (open.length === 0 && cleared.length === 0) return;

    await this.pager.page(
      digestPage(
        open.map(view),
        cleared.map((i) => ({ ...view(i), closedAt: i.closedAt ?? now })),
        mode === "digest",
        now,
      ),
    );
    await this.prisma.blockIncident.updateMany({
      where: { id: { in: [...open, ...cleared].map((i) => i.id) } },
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
      evidenceJson: true,
      pagedAt: true,
      pageError: true,
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
    const incident = await this.prisma.blockIncident.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!incident) throw new NotFoundException("No such incident");
    if (incident.status !== BlockIncidentStatus.OPEN) throw new BadRequestException("This incident is already closed");
    const common = { actedBy: by, actionNote: opts.note?.trim() || null };
    let data: Prisma.BlockIncidentUpdateInput;
    switch (action) {
      case "replaced":
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

  /** Dials of direct routes in recent connect reports from signed-in
   * customers on networks registered in the watched country, by server.
   * Relayed routes are left out: a failure there may be the relay's leg
   * abroad, not the server the customer dialled. */
  private async loadDials(now: number): Promise<Map<string, NodeDial[]>> {
    const rows = await this.prisma.clientAttempt.findMany({
      where: {
        kind: ClientAttemptKind.CONNECT,
        customerId: { not: null },
        asn: { not: null },
        createdAt: { gte: new Date(now - BASELINE_MS) },
      },
      select: { customerId: true, asn: true, attemptsJson: true, createdAt: true, occurredAt: true },
      orderBy: { createdAt: "desc" },
      take: MAX_REPORT_ROWS,
    });
    const routes = await this.prisma.route.findMany({
      where: { exitProtocolConfigId: null },
      select: { id: true, entryProtocolConfig: { select: { nodeId: true, protocol: true } } },
    });
    const routeNode = new Map(routes.map((r) => [r.id, r.entryProtocolConfig]));

    const byNode = new Map<string, NodeDial[]>();
    const watched = new Map<number, boolean>();
    for (const row of rows) {
      const asn = row.asn!;
      if (!watched.has(asn)) watched.set(asn, this.identity.countryOfAsn(asn)?.toLowerCase() === this.country);
      if (!watched.get(asn)) continue;
      const at = happenedAt(row);
      for (const dial of dialsOf({ ...row, kind: "CONNECT", outcome: "", routeId: null, sessionSeconds: null })) {
        const entry = routeNode.get(dial.routeId);
        if (!entry) continue;
        const list = byNode.get(entry.nodeId) ?? [];
        list.push({ customerId: row.customerId!, asn, carried: dial.carried, at, protocol: entry.protocol });
        byNode.set(entry.nodeId, list);
      }
    }
    return byNode;
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
   * the last window and in the same window on each of the days before:
   * day 0 is now. One grouped query a day. */
  private async loadTraffic(now: number): Promise<Map<string, Map<number, number>>> {
    const days = BASELINE_MS / 86_400_000;
    const byNode = new Map<string, Map<number, number>>();
    for (let day = 0; day <= days; day += 1) {
      const end = now - day * 86_400_000;
      const groups = await this.prisma.usageRecord.groupBy({
        by: ["nodeId", "subscriptionId"],
        where: { reportedAt: { gte: new Date(end - TRAFFIC_WINDOW_MS), lt: new Date(end) } },
        _sum: { bytesUp: true },
        having: { bytesUp: { _sum: { gte: UPSTREAM_ACTIVE_BYTES } } },
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

/** A server's traffic counts, with the days before `floor` (the owner's
 * last answer) left out as not comparable. */
export function trafficSince(counts: Map<number, number> | undefined, now: number, floor: number): TrafficCounts {
  const baseline: (number | null)[] = [];
  for (let day = 1; day <= BASELINE_MS / 86_400_000; day += 1) {
    const start = now - day * 86_400_000 - TRAFFIC_WINDOW_MS;
    baseline.push(start < floor ? null : (counts?.get(day) ?? 0));
  }
  return { current: counts?.get(0) ?? 0, baseline };
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

function view(i: BlockIncident & { node: { name: string } }): IncidentView {
  return { nodeName: i.node.name, openedAt: i.openedAt, evidence: i.evidenceJson as unknown as StoredEvidence };
}
