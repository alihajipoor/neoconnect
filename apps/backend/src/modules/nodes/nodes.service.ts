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
/** Heartbeat-gap messages an hour, across the fleet. Each sweep's new
 * gaps are one message, and its returns another. */
const HEARTBEAT_GAP_PAGES_PER_HOUR = 4;
/** After a node was said to be back, a new gap on it is not paged for
 * this long: a node on a flapping link would otherwise page "stopped"
 * and "back" all day. The webhook-only alerts still report every gap. */
export const HEARTBEAT_GAP_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** Tries at one gap's page that reached nobody before giving up on it. */
const HEARTBEAT_GAP_PAGE_TRIES = 3;

/** HEARTBEAT_GAP_PAGE_MINUTES: whole minutes, or 0 (off). Blank -- an
 * unset knob arrives through Compose as "" -- and anything unreadable are
 * off: paging a person is opted into, never on by default. */
export function heartbeatGapPageMinutes(raw: string | number | null | undefined): number {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  return Number(text);
}

@Injectable()
export class NodesService {
  /** nodeId -> when we last said it was still offline. In memory on
   * purpose: a restart clearing it means the next sweep re-reports
   * everything currently down, which is the right thing to do after a
   * restart rather than a bug. */
  private readonly lastOfflineReminderAt = new Map<string, number>();
  private readonly logger = new Logger(NodesService.name);
  private readonly gapBudget = new HourlyBudget(HEARTBEAT_GAP_PAGES_PER_HOUR);
  /** "nodeId@gap start" -> pages for that gap that reached nobody. In
   * memory: a restart allows a few more tries, which is harmless. */
  private readonly undeliveredGapPages = new Map<string, number>();

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
    // The end of a paged gap is told by the sweep (pageHeartbeatGaps), not
    // here: this runs inside an agent's Hello, before its customers'
    // credentials and routes are re-sent, and a mail server that hangs must
    // not hold that up.
  }

  /** Pages the owner (webhook and every SUPERADMIN's mailbox) when a node
   * has sent no heartbeat for HEARTBEAT_GAP_PAGE_MINUTES, once per gap,
   * and once more when it is back. Off unless that is set. The transition
   * and six-hourly alerts go to the webhook only; this is the one meant to
   * reach a person. A gap is an outage, not a block.
   *
   * Each sweep sends at most one message for the gaps it found and one for
   * the returns, however many nodes. A gap counts as paged only once its
   * page reached somebody; until then later sweeps try again, a few times.
   * A node said to be back is not paged again for a while
   * (HEARTBEAT_GAP_COOLDOWN_MS).
   *
   * Never throws. Called by the stale-node sweep. */
  async pageHeartbeatGaps(now: number = Date.now()): Promise<void> {
    try {
      const minutes = heartbeatGapPageMinutes(this.config.get<string | number>("heartbeatGapPageMinutes"));
      if (minutes <= 0) return;
      await this.pageReturns(now);
      await this.pageNewGaps(now, minutes);
    } catch (err) {
      this.logger.warn(`Heartbeat-gap paging failed: ${(err as Error).message}`);
    }
  }

  private async pageNewGaps(now: number, minutes: number): Promise<void> {
    const found = await this.prisma.node.findMany({
      where: {
        status: "OFFLINE",
        heartbeatGapPagedAt: null,
        lastHeartbeatAt: { lte: new Date(now - minutes * 60_000), gt: new Date(now - HEARTBEAT_GAP_PAGE_HORIZON_MS) },
        OR: [{ heartbeatBackPagedAt: null }, { heartbeatBackPagedAt: { lte: new Date(now - HEARTBEAT_GAP_COOLDOWN_MS) } }],
      },
      select: { id: true, name: true, lastHeartbeatAt: true },
      orderBy: { lastHeartbeatAt: "asc" },
    });
    const keyOf = (node: { id: string; lastHeartbeatAt: Date | null }) => `${node.id}@${node.lastHeartbeatAt?.getTime()}`;
    const present = new Set(found.map(keyOf));
    for (const key of [...this.undeliveredGapPages.keys()]) {
      if (!present.has(key)) this.undeliveredGapPages.delete(key);
    }
    const quiet = found.filter((n) => (this.undeliveredGapPages.get(keyOf(n)) ?? 0) < HEARTBEAT_GAP_PAGE_TRIES);
    if (quiet.length === 0 || !this.gapBudget.take(now)) return;

    const gaps = quiet.map((node) => {
      const since = node.lastHeartbeatAt!;
      return { name: node.name, since: since.toISOString(), minutes: Math.round((now - since.getTime()) / 60_000) };
    });
    const one = gaps.length === 1 ? gaps[0] : null;
    const delivery = await this.pager.page({
      subject: one ? `[Neoxify] ${one.name} has stopped heartbeating` : `[Neoxify] ${gaps.length} nodes have stopped heartbeating`,
      webhook: one
        ? `[node] ${one.name}: no heartbeat for ${one.minutes} min (since ${one.since})`
        : `[node] no heartbeat from ${gaps.map((g) => `${g.name} (${g.minutes} min)`).join(", ")}`,
      context: { event: "heartbeat_gap", nodes: gaps.map((g) => g.name) },
      text:
        (one
          ? `The agent on ${one.name} has sent no heartbeat for ${one.minutes} minutes, since ${one.since}. `
          : `${gaps.length} agents have sent no heartbeat:\n` +
            gaps.map((g) => `- ${g.name}: ${g.minutes} minutes, since ${g.since}`).join("\n") +
            "\n\nSeveral at once is more often a fault on our side or a network cut than separate failures. ") +
        "Customers on them may be cut off. This is an outage -- the server, its network or the agent -- not a block.\n\n" +
        "You will hear once more when it is back. Nothing has been changed automatically.",
    });
    if (!delivery.delivered) {
      // Left unmarked, so a later sweep tries again -- a few times.
      this.logger.warn(`Heartbeat-gap page reached nobody: ${delivery.error ?? "no reason given"}`);
      for (const node of quiet) this.undeliveredGapPages.set(keyOf(node), (this.undeliveredGapPages.get(keyOf(node)) ?? 0) + 1);
      return;
    }
    if (delivery.error) this.logger.warn(`Heartbeat-gap page: ${delivery.error}`);
    await this.prisma.node.updateMany({
      where: { id: { in: quiet.map((n) => n.id) } },
      data: { heartbeatGapPagedAt: new Date(now) },
    });
    for (const node of quiet) this.undeliveredGapPages.delete(keyOf(node));
  }

  /** Nodes whose gap was paged and that heartbeat again: one message for
   * all of them. */
  private async pageReturns(now: number): Promise<void> {
    const back = await this.prisma.node.findMany({
      where: { status: "ONLINE", heartbeatGapPagedAt: { not: null } },
      select: { id: true, name: true, heartbeatGapPagedAt: true },
      orderBy: { name: "asc" },
    });
    if (back.length === 0 || !this.gapBudget.take(now)) return;
    const names = back.map((n) => n.name);
    const one = back.length === 1 ? back[0] : null;
    const delivery = await this.pager.page({
      subject: one ? `[Neoxify] ${one.name} is heartbeating again` : `[Neoxify] ${back.length} nodes are heartbeating again`,
      webhook: `[node] heartbeating again: ${names.join(", ")}`,
      context: { event: "heartbeat_gap_ended", nodes: names },
      text:
        (one
          ? `The agent on ${one.name} has connected again; its gap was paged at ${one.heartbeatGapPagedAt!.toISOString()}. `
          : `These agents have connected again: ${names.join(", ")}. `) +
        "The backend re-sends their customers' credentials and routes as each one reconnects.",
    });
    // Marked either way: a missed "back" is not worth repeating, and the
    // cooldown runs from here.
    if (delivery.error) this.logger.warn(`Heartbeat-return page: ${delivery.error}`);
    await this.prisma.node.updateMany({
      where: { id: { in: back.map((n) => n.id) } },
      data: { heartbeatGapPagedAt: null, heartbeatBackPagedAt: new Date(now) },
    });
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
