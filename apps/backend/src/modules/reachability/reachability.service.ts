import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdminRole, NodeStatus, ReachabilityVerdict } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AlertingService } from "../alerting/alerting.service";
import { EmailService } from "../email/email.service";
import { CheckHostClient, type ProbeOutcome, type ProbeResult } from "./check-host.client";
import { reachabilityAlertEmail, reachabilityRecoveryEmail } from "./reachability.emails";

/** Below this share of answering vantages, a node is DEGRADED rather
 * than REACHABLE.
 *
 * Half, not "all", because a perfect score is not the normal state of a
 * working node in Iran: individual operators blackhole ranges, vantages
 * sit behind flaky transit, and demanding 8/8 would mean a permanent
 * amber light that everyone learns to ignore. */
const HEALTHY_RATIO = 0.5;

/** Fewer answering vantages than this and the cycle is INCONCLUSIVE
 * regardless of what they said.
 *
 * One vantage agreeing with itself is not evidence. This is the floor
 * that stops a cycle where seven of eight probes silently vanished from
 * declaring a node dead on the strength of the one that was left. */
const MIN_ANSWERS_FOR_A_VERDICT = 2;

export interface CycleSummary {
  nodeId: string;
  nodeName: string;
  verdict: ReachabilityVerdict;
  probesOk: number;
  probesAnswered: number;
}

/**
 * Measures whether nodes can actually be reached from inside Iran, and
 * tells the operator when one stops being reachable.
 *
 * The gap this fills: `nodes.status` is reported by the node's own
 * agent, over a connection the node opens outbound. A node that is
 * comprehensively blocked at the Iranian border keeps heartbeating
 * perfectly and keeps reading ONLINE, while no customer in the country
 * can open a socket to it. turkey-1 sat exactly like that -- ONLINE,
 * agent healthy, zero successful connections for three days -- and
 * nothing in the system said a word.
 *
 * Nothing here throws into its caller. A monitor that can take down the
 * thing it monitors is worse than no monitor.
 */
@Injectable()
export class ReachabilityService {
  private readonly logger = new Logger(ReachabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly checkHost: CheckHostClient,
    private readonly email: EmailService,
    private readonly alerting: AlertingService,
  ) {}

  private get country(): string {
    return this.config.get<string>("reachability.country") ?? "ir";
  }

  private get port(): number {
    return this.config.get<number>("reachability.port") ?? 443;
  }

  private get failuresBeforeAlert(): number {
    return Math.max(1, this.config.get<number>("reachability.failuresBeforeAlert") ?? 2);
  }

  /**
   * Probe every node once and act on the result.
   *
   * Nodes are probed one after another rather than in parallel. The
   * provider is a free service with unpublished rate limits, and
   * tripping them would turn every node INCONCLUSIVE at once -- the
   * single failure mode this design is most concerned with avoiding. A
   * handful of nodes every half hour has all the time in the world.
   */
  async runCycle(): Promise<CycleSummary[]> {
    if (this.config.get<boolean>("reachability.enabled") === false) {
      this.logger.debug("Reachability probing is disabled");
      return [];
    }

    const nodes = await this.prisma.node.findMany({
      // PENDING nodes have never been provisioned and OFFLINE ones are a
      // problem the heartbeat already reports. Probing either would
      // produce alerts about nodes nobody is trying to use.
      where: { status: NodeStatus.ONLINE },
      select: { id: true, name: true, publicIp: true },
      orderBy: { name: "asc" },
    });
    if (nodes.length === 0) return [];

    const vantages = await this.checkHost.vantagesIn(this.country);
    if (vantages.length === 0) {
      // No vantages means no measurement. Recording a verdict here would
      // be inventing data, so the cycle is abandoned and says why.
      this.logger.warn(`No ${this.country} vantage points available; skipping this cycle`);
      return [];
    }

    const summaries: CycleSummary[] = [];
    for (const node of nodes) {
      try {
        summaries.push(await this.probeNode(node, vantages));
      } catch (err) {
        // One node's failure must not abandon the rest of the fleet.
        this.logger.error(`Reachability probe failed for ${node.name}: ${(err as Error).message}`);
      }
    }

    await this.pruneHistory();
    return summaries;
  }

  private async probeNode(
    node: { id: string; name: string; publicIp: string },
    vantages: string[],
  ): Promise<CycleSummary> {
    const outcome = await this.checkHost.tcpCheck(node.publicIp, this.port, vantages);
    const verdict = this.verdictFor(outcome);

    const okResults = outcome.results.filter((r) => r.ok);
    const check = await this.prisma.nodeReachabilityCheck.create({
      data: {
        nodeId: node.id,
        country: this.country,
        port: this.port,
        verdict,
        probesOk: okResults.length,
        probesAnswered: outcome.results.length,
        probesRequested: outcome.requested,
        medianLatencyMs: medianOf(okResults.map((r) => r.latencyMs ?? 0)),
        detailJson: outcome.results as unknown as object,
      },
    });

    await this.reconcileAlert(node, verdict, check.checkedAt);

    return {
      nodeId: node.id,
      nodeName: node.name,
      verdict,
      probesOk: okResults.length,
      probesAnswered: outcome.results.length,
    };
  }

  /**
   * Turn a set of probe results into a verdict.
   *
   * The INCONCLUSIVE branch is the important one and the reason this is
   * a separate, tested function: when check-host is down or rate-limits
   * us, every node returns nothing. Treating that as UNREACHABLE would
   * email the operator that the entire fleet is filtered because a third
   * party had a bad minute, and an alert that cries wolf is worse than
   * none at all.
   */
  verdictFor(outcome: ProbeOutcome): ReachabilityVerdict {
    const answered = outcome.results.length;
    if (answered < MIN_ANSWERS_FOR_A_VERDICT) return ReachabilityVerdict.INCONCLUSIVE;

    const ok = outcome.results.filter((r) => r.ok).length;
    if (ok === 0) return ReachabilityVerdict.UNREACHABLE;
    if (ok / answered >= HEALTHY_RATIO) return ReachabilityVerdict.REACHABLE;
    return ReachabilityVerdict.DEGRADED;
  }

  /**
   * Open, hold or resolve the incident for this node.
   *
   * Only UNREACHABLE counts toward an alert. DEGRADED deliberately does
   * not: a node blocked on one Iranian operator out of eight is a real
   * and visible event, but it is also an ordinary Tuesday, and paging on
   * it trains the operator to ignore the mail.
   */
  private async reconcileAlert(
    node: { id: string; name: string },
    verdict: ReachabilityVerdict,
    checkedAt: Date,
  ): Promise<void> {
    const open = await this.prisma.nodeReachabilityAlert.findFirst({
      where: { nodeId: node.id, country: this.country, resolvedAt: null },
    });

    // INCONCLUSIVE is neither failure nor recovery: it is the absence of
    // information. It must not resolve a live incident -- that would
    // declare a node recovered because the prober went down -- and it
    // must not extend one either.
    if (verdict === ReachabilityVerdict.INCONCLUSIVE) return;

    const failing = verdict === ReachabilityVerdict.UNREACHABLE;

    if (!failing) {
      if (open) {
        await this.prisma.nodeReachabilityAlert.update({
          where: { id: open.id },
          data: { resolvedAt: checkedAt },
        });
        await this.notifyRecovery(node, open.openedAt, checkedAt);
      }
      return;
    }

    // Already reported. Staying quiet is the whole point of storing the
    // incident rather than recomputing it: without this the operator
    // gets the same mail every half hour until they fix it.
    if (open) return;

    const streak = await this.consecutiveFailures(node.id);
    if (streak < this.failuresBeforeAlert) return;

    const alert = await this.prisma.nodeReachabilityAlert.create({
      data: { nodeId: node.id, country: this.country, consecutiveFailures: streak },
    });
    await this.notifyOutage(node, streak, alert.id);
  }

  /** How many of the most recent cycles in a row were UNREACHABLE.
   *
   * INCONCLUSIVE cycles are skipped rather than counted or treated as a
   * reset: a prober hiccup in the middle of a genuine outage should
   * neither mask it nor manufacture it. */
  private async consecutiveFailures(nodeId: string): Promise<number> {
    const recent = await this.prisma.nodeReachabilityCheck.findMany({
      where: { nodeId, country: this.country },
      orderBy: { checkedAt: "desc" },
      take: 20,
      select: { verdict: true },
    });

    let streak = 0;
    for (const { verdict } of recent) {
      if (verdict === ReachabilityVerdict.INCONCLUSIVE) continue;
      if (verdict !== ReachabilityVerdict.UNREACHABLE) break;
      streak += 1;
    }
    return streak;
  }

  /** Everyone who should hear about a node going dark. */
  private async recipients(): Promise<string[]> {
    const configured = this.config.get<string>("reachability.recipients");
    if (configured) {
      return configured
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);
    }
    const admins = await this.prisma.adminUser.findMany({
      where: { role: AdminRole.SUPERADMIN },
      select: { email: true },
    });
    return admins.map((a) => a.email);
  }

  private async notifyOutage(
    node: { id: string; name: string },
    streak: number,
    alertId: string,
  ): Promise<void> {
    const minutes = streak * 30;
    await this.alerting.send(
      `Node ${node.name} is unreachable from ${this.country.toUpperCase()} (${streak} consecutive checks, ~${minutes} min)`,
      { nodeId: node.id, country: this.country },
    );

    const to = await this.recipients();
    if (to.length === 0) {
      this.logger.warn(`No alert recipients configured; ${node.name} outage not emailed`);
      return;
    }

    const mail = reachabilityAlertEmail(node.name, this.country, streak, this.port);
    const failures: string[] = [];
    for (const address of to) {
      const sent = await this.email.sendMail({ to: address, ...mail });
      if (!sent) failures.push(address);
    }

    // Recorded rather than logged and forgotten. An alert that was
    // raised but never delivered looks identical, in the table, to one
    // the operator simply has not acted on yet.
    await this.prisma.nodeReachabilityAlert.update({
      where: { id: alertId },
      data: {
        notifiedAt: failures.length < to.length ? new Date() : null,
        notifyError: failures.length ? `could not mail: ${failures.join(", ")}` : null,
      },
    });
  }

  private async notifyRecovery(
    node: { id: string; name: string },
    openedAt: Date,
    recoveredAt: Date,
  ): Promise<void> {
    const minutes = Math.max(1, Math.round((recoveredAt.getTime() - openedAt.getTime()) / 60_000));
    await this.alerting.send(
      `Node ${node.name} is reachable from ${this.country.toUpperCase()} again after ~${minutes} min`,
      { nodeId: node.id, country: this.country },
    );

    const to = await this.recipients();
    const mail = reachabilityRecoveryEmail(node.name, this.country, minutes);
    for (const address of to) {
      await this.email.sendMail({ to: address, ...mail });
    }
  }

  /** Probe history is diagnostic, not accounting. */
  private async pruneHistory(): Promise<void> {
    const days = this.config.get<number>("reachability.retentionDays") ?? 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
    await this.prisma.nodeReachabilityCheck.deleteMany({ where: { checkedAt: { lt: cutoff } } });
  }

  /** Latest verdict per node, for the panel's overview table. */
  async currentStatus() {
    const nodes = await this.prisma.node.findMany({
      select: { id: true, name: true, region: true, status: true },
      orderBy: { name: "asc" },
    });

    const results = await Promise.all(
      nodes.map(async (node) => {
        const latest = await this.prisma.nodeReachabilityCheck.findFirst({
          where: { nodeId: node.id, country: this.country },
          orderBy: { checkedAt: "desc" },
        });
        const openAlert = await this.prisma.nodeReachabilityAlert.findFirst({
          where: { nodeId: node.id, country: this.country, resolvedAt: null },
          select: { openedAt: true, notifiedAt: true },
        });
        return { node, latest, openAlert };
      }),
    );

    return results.map(({ node, latest, openAlert }) => ({
      nodeId: node.id,
      name: node.name,
      region: node.region,
      agentStatus: node.status,
      verdict: latest?.verdict ?? null,
      probesOk: latest?.probesOk ?? null,
      probesAnswered: latest?.probesAnswered ?? null,
      medianLatencyMs: latest?.medianLatencyMs ?? null,
      checkedAt: latest?.checkedAt ?? null,
      port: latest?.port ?? this.port,
      detail: (latest?.detailJson as unknown as ProbeResult[] | null) ?? [],
      openSince: openAlert?.openedAt ?? null,
      alertDelivered: openAlert ? openAlert.notifiedAt !== null : null,
    }));
  }

  /** Recent cycles for one node, newest first. */
  async history(nodeId: string, limit = 48) {
    return this.prisma.nodeReachabilityCheck.findMany({
      where: { nodeId, country: this.country },
      orderBy: { checkedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }
}

/** Median, not mean: one vantage behind terrible transit should not drag
 * the number for the other seven. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}
