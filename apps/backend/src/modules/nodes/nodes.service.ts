import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AlertingService } from "../alerting/alerting.service";
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

@Injectable()
export class NodesService {
  /** nodeId -> when we last said it was still offline. In memory on
   * purpose: a restart clearing it means the next sweep re-reports
   * everything currently down, which is the right thing to do after a
   * restart rather than a bug. */
  private readonly lastOfflineReminderAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerting: AlertingService,
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
    const previous = await this.prisma.node.findUnique({ where: { id }, select: { status: true, name: true } });

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
