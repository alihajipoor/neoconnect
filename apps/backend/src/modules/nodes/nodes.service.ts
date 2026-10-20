import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { AlertingService } from "../alerting/alerting.service";
import { HourlyBudget, PagerService } from "../alerting/pager.service";
import { CreateNodeDto } from "./dto/create-node.dto";

/** How long between repeat alerts for a node that is still OFFLINE.
 *
 * setStatus alerts on the ONLINE->OFFLINE transition and then never
 * again, so a node that goes down and stays down produces exactly one
 * message. germany-1 and singapore-1 went OFFLINE within ten seconds of
 * each other on 2026-08-24, both alerts fired, and the fleet then ran at
 * four of six nodes for six days because one notification six days ago
 * is indistinguishable from a blip nobody needed to act on.
 *
 * Six hours is chosen to be impossible to mistake for a blip and still
 * quiet enough that a genuinely retired node does not become noise the
 * team learns to filter. See docs/journal/log.md, 2026-08-30. */
const STILL_OFFLINE_REMINDER_MS = 6 * 60 * 60 * 1000;

/** A gap older than this when first seen is not paged: it began before
 * the backend was watching (a restart, a deploy) or belongs to a node
 * long gone, and the six-hourly webhook reminder already covers it. */
const HEARTBEAT_GAP_PAGE_HORIZON_MS = 24 * 60 * 60 * 1000;
/** Heartbeat-gap pages an hour, across the fleet, so a fault of ours that
 * drops every node at once is a handful of mails, not one per node. */
const HEARTBEAT_GAP_PAGES_PER_HOUR = 4;

@Injectable()
export class NodesService {
  /** nodeId -> when we last said it was still offline. In memory on
   * purpose: a restart clearing it means the next sweep re-reports
   * everything currently down, which is the right thing to do after a
   * restart rather than a bug. */
  private readonly lastOfflineReminderAt = new Map<string, number>();
  private readonly logger = new Logger(NodesService.name);
  private readonly gapBudget = new HourlyBudget(HEARTBEAT_GAP_PAGES_PER_HOUR);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerting: AlertingService,
    private readonly pager: PagerService,
    private readonly config: ConfigService,
  ) {}

  list() {
    return this.prisma.node.findMany({ orderBy: { createdAt: "desc" } });
  }

  async get(id: string) {
    const node = await this.prisma.node.findUnique({ where: { id } });
    if (!node) {
      throw new NotFoundException("Node not found");
    }
    return node;
  }

  create(dto: CreateNodeDto) {
    return this.prisma.node.create({ data: dto });
  }

  /** A bare `prisma.node.delete()` 500s the instant anything still
   * references this node -- previously unhandled, hit for real while
   * cleaning up M15 test fixtures (see project memory). Splits the
   * node's dependents into two kinds: things that represent real,
   * still-meaningful state (ProtocolConfigs -- registered engines that
   * might have live customers on them; Subscriptions with this as
   * their primaryNode) block deletion with a clear, count-based
   * message rather than silently cascading; things that are just
   * bookkeeping/history for a node that's being decommissioned
   * (AgentCommand outbox rows, UsageRecord history, EnrollmentToken
   * history) are cleared automatically since keeping them around after
   * the node itself is gone serves no purpose. */
  async remove(id: string) {
    await this.get(id);

    const [protocolConfigCount, subscriptionCount] = await Promise.all([
      this.prisma.protocolConfig.count({ where: { nodeId: id } }),
      this.prisma.subscription.count({ where: { primaryNodeId: id } }),
    ]);
    if (protocolConfigCount > 0) {
      throw new BadRequestException(
        `Cannot delete this node -- it still has ${protocolConfigCount} protocol config(s). Remove those first.`,
      );
    }
    if (subscriptionCount > 0) {
      throw new BadRequestException(
        `Cannot delete this node -- it's still the primary node for ${subscriptionCount} subscription(s).`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.agentCommand.deleteMany({ where: { nodeId: id } }),
      this.prisma.usageRecord.deleteMany({ where: { nodeId: id } }),
      this.prisma.enrollmentToken.deleteMany({ where: { nodeId: id } }),
      this.prisma.node.delete({ where: { id } }),
    ]);
  }

  /** Called by the agent gateway on successful Hello / on stream close /
   * on stale-heartbeat sweep -- kept as a single narrow write path so
   * status transitions are easy to audit, rather than scattering
   * `prisma.node.update` calls. Also the one place that alerts on a
   * real ONLINE<->OFFLINE transition (compares against the prior status
   * so a redundant call -- e.g. the sweep and a stream-close event both
   * racing to mark the same node OFFLINE -- doesn't double-alert). */
  async setStatus(id: string, status: "ONLINE" | "OFFLINE", extra?: { agentVersion?: string }) {
    const previous = await this.prisma.node.findUnique({
      where: { id },
      select: { status: true, name: true, heartbeatGapPagedAt: true, lastHeartbeatAt: true },
    });

    await this.prisma.node.update({
      where: { id },
      data: {
        status,
        lastHeartbeatAt: status === "ONLINE" ? new Date() : undefined,
        agentVersion: extra?.agentVersion,
      },
    });

    if (previous && previous.status !== status) {
      const label = status === "OFFLINE" ? "went OFFLINE" : "is back ONLINE";
      await this.alerting.send(`Node "${previous.name}" (${id}) ${label}`, {
        event: status === "OFFLINE" ? "node_offline" : "node_online",
        nodeId: id,
        nodeName: previous.name,
      });
    }

    // The owner was paged that this node went quiet: say it is back, once.
    if (status === "ONLINE" && previous?.heartbeatGapPagedAt) {
      await this.prisma.node.update({ where: { id }, data: { heartbeatGapPagedAt: null } });
      const minutes = previous.lastHeartbeatAt
        ? Math.max(1, Math.round((Date.now() - previous.lastHeartbeatAt.getTime()) / 60_000))
        : null;
      await this.pager.page({
        subject: `[Neoxify] ${previous.name} is heartbeating again`,
        webhook: `[node] ${previous.name} is heartbeating again${minutes ? ` after ~${minutes} min` : ""}`,
        context: { event: "heartbeat_gap_ended", nodeName: previous.name },
        text:
          `The agent on ${previous.name} has connected again${minutes ? `, after about ${minutes} minutes without a heartbeat` : ""}. ` +
          "Its customers' credentials and routes are being re-sent to it now.",
      });
    }
  }

  /** Pages the owner (webhook and every SUPERADMIN's mailbox) when a node
   * has sent no heartbeat for HEARTBEAT_GAP_PAGE_MINUTES: once per gap,
   * and once more when it comes back (setStatus). The transition and
   * six-hourly alerts go to the webhook only; this is the one that is
   * meant to reach a person. A gap is an outage, not a block.
   *
   * Never throws. Called by the stale-node sweep. */
  async pageHeartbeatGaps(now: number = Date.now()): Promise<void> {
    try {
      // Blank (an unset knob arrives through Compose as "") is the default.
      const raw = String(this.config.get<string | number>("heartbeatGapPageMinutes") ?? "").trim();
      const minutes = raw === "" ? 10 : Number(raw);
      if (!Number.isFinite(minutes) || minutes <= 0) return;
      const quiet = await this.prisma.node.findMany({
        where: {
          status: "OFFLINE",
          heartbeatGapPagedAt: null,
          lastHeartbeatAt: { lte: new Date(now - minutes * 60_000), gt: new Date(now - HEARTBEAT_GAP_PAGE_HORIZON_MS) },
        },
        select: { id: true, name: true, lastHeartbeatAt: true },
        orderBy: { lastHeartbeatAt: "asc" },
      });
      for (const node of quiet) {
        if (!this.gapBudget.take(now)) break;
        const since = node.lastHeartbeatAt!;
        const gap = Math.round((now - since.getTime()) / 60_000);
        const delivery = await this.pager.page({
          subject: `[Neoxify] ${node.name} has stopped heartbeating`,
          webhook: `[node] ${node.name}: no heartbeat for ${gap} min (since ${since.toISOString()})`,
          context: { event: "heartbeat_gap", nodeName: node.name, since: since.toISOString() },
          text:
            `The agent on ${node.name} has sent no heartbeat for ${gap} minutes, since ${since.toISOString()}. ` +
            "Its customers may be cut off. This is an outage -- the server, its network or the agent -- not a block.\n\n" +
            "You will hear once more when it is back. Nothing has been changed automatically.",
        });
        if (delivery.error) this.logger.warn(`Heartbeat-gap page for ${node.name}: ${delivery.error}`);
        await this.prisma.node.update({ where: { id: node.id }, data: { heartbeatGapPagedAt: new Date(now) } });
      }
    } catch (err) {
      this.logger.warn(`Heartbeat-gap paging failed: ${(err as Error).message}`);
    }
  }

  /** Re-alerts for nodes that are still OFFLINE, and forgets the ones
   * that came back.
   *
   * Called from the stale-node sweep. Deliberately separate from
   * setStatus: that one fires on a transition, this one fires on a
   * state that is *persisting*, and the six-day outage this exists to
   * prevent produced no transitions at all after the first minute.
   *
   * Never throws -- the sweep has real work to finish either way, and
   * alerting is optional infrastructure. */
  async remindAboutOfflineNodes(): Promise<void> {
    const offline = await this.prisma.node.findMany({
      where: { status: "OFFLINE" },
      select: { id: true, name: true, lastHeartbeatAt: true },
    });

    const stillOffline = new Set(offline.map((n) => n.id));
    for (const id of [...this.lastOfflineReminderAt.keys()]) {
      if (!stillOffline.has(id)) {
        this.lastOfflineReminderAt.delete(id);
      }
    }

    const now = Date.now();
    for (const node of offline) {
      const last = this.lastOfflineReminderAt.get(node.id) ?? 0;
      if (now - last < STILL_OFFLINE_REMINDER_MS) {
        continue;
      }
      this.lastOfflineReminderAt.set(node.id, now);

      const downFor = node.lastHeartbeatAt
        ? `${Math.round((now - node.lastHeartbeatAt.getTime()) / 3_600_000)}h`
        : "an unknown time";
      await this.alerting.send(
        `Node "${node.name}" (${node.id}) is STILL OFFLINE -- no heartbeat for ${downFor}`,
        {
          event: "node_still_offline",
          nodeId: node.id,
          nodeName: node.name,
          offlineSince: node.lastHeartbeatAt?.toISOString(),
        },
      );
    }
  }

  /** Suppresses the first repeat alert for a node the sweep has just
   * marked OFFLINE, so the transition alert and the still-offline
   * reminder do not arrive together. The reminder is for a state that
   * has persisted; one interval has to pass before that is true. */
  suppressNextOfflineReminder(id: string) {
    this.lastOfflineReminderAt.set(id, Date.now());
  }

  /** Records what a node says about its own REALITY dest, and alerts when
   * that answer changes.
   *
   * Transition-based like setStatus, and for the same reason: a dest that
   * is fine should be silent. Unlike node status, this one does not need a
   * repeat reminder -- an unreachable dest makes the node useless for
   * REALITY, so it will be dealt with rather than lived with.
   *
   * `dest` empty means the agent did not measure (no REALITY inbound, or
   * an agent older than v0.2.8). That is written through as NULL and
   * never alerted on: "did not say" is not "broken", and treating them
   * alike would page for the entire fleet the day this ships.
   */
  async recordRealityDestHealth(id: string, dest: string, reachable: boolean): Promise<void> {
    if (!dest) {
      return;
    }
    const previous = await this.prisma.node.findUnique({
      where: { id },
      select: { name: true, realityDest: true, realityDestReachable: true },
    });

    await this.prisma.node.update({
      where: { id },
      data: {
        realityDest: dest,
        realityDestReachable: reachable,
        realityDestCheckedAt: new Date(),
      },
    });

    if (!previous) {
      return;
    }
    // Alert on a change of answer, and on the first answer if it is bad.
    // A node whose dest was already known-bad does not re-alert every
    // heartbeat.
    const changed = previous.realityDest !== dest || previous.realityDestReachable !== reachable;
    if (!changed) {
      return;
    }
    if (!reachable) {
      await this.alerting.send(
        `Node "${previous.name}" (${id}) cannot reach its REALITY dest ${dest} -- ` +
          `clients will complete TCP and then hang`,
        { event: "reality_dest_unreachable", nodeId: id, nodeName: previous.name, dest },
      );
    } else if (previous.realityDestReachable === false) {
      await this.alerting.send(`Node "${previous.name}" (${id}) can reach its REALITY dest ${dest} again`, {
        event: "reality_dest_recovered",
        nodeId: id,
        nodeName: previous.name,
        dest,
      });
    }
  }

  async touchHeartbeat(id: string) {
    await this.prisma.node.update({ where: { id }, data: { lastHeartbeatAt: new Date() } });
  }
}
