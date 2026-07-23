import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { Protocol } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";

export interface UsageDeltaInput {
  externalUserId: string;
  protocol: string;
  bytesUp: string;
  bytesDown: string;
}

/** Turns agent-reported StatsBatch deltas into UsageRecords + cap
 * enforcement, and provides the sweep jobs' quota/expiry checks. Depends
 * on AgentGatewayService (to hot-disable a subscription's ProtocolUsers),
 * which in turn needs this service to handle incoming statsBatch
 * messages -- a genuine two-way dependency, broken with forwardRef()
 * rather than restructuring either service's otherwise-natural scope. */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AgentGatewayService))
    private readonly agentGateway: AgentGatewayService,
  ) {}

  async recordDeltas(nodeId: string, deltas: UsageDeltaInput[]) {
    for (const delta of deltas) {
      await this.recordOne(nodeId, delta);
    }
  }

  private async recordOne(nodeId: string, delta: UsageDeltaInput) {
    if (!isProtocol(delta.protocol)) {
      this.logger.warn(`Dropping usage delta with unknown protocol ${delta.protocol} from node ${nodeId}`);
      return;
    }

    const bytesUp = BigInt(delta.bytesUp || "0");
    const bytesDown = BigInt(delta.bytesDown || "0");
    if (bytesUp === 0n && bytesDown === 0n) return;

    const protocolUser = await this.prisma.protocolUser.findFirst({
      where: { nodeId, protocol: delta.protocol, externalUserId: delta.externalUserId },
    });
    if (!protocolUser) {
      // Most commonly a relay's shared uplink identity (route:<id>),
      // which has no ProtocolUser row by design -- see routes.service.ts.
      // Not an error, just nothing to record usage against.
      return;
    }

    const lastRecord = await this.prisma.usageRecord.findFirst({
      where: { protocolUserId: protocolUser.id },
      orderBy: { reportedAt: "desc" },
      select: { reportedAt: true },
    });
    const periodStart = lastRecord?.reportedAt ?? protocolUser.createdAt;
    const periodEnd = new Date();

    const subscription = await this.prisma.$transaction(async (tx) => {
      await tx.usageRecord.create({
        data: {
          protocolUserId: protocolUser.id,
          subscriptionId: protocolUser.subscriptionId,
          nodeId,
          periodStart,
          periodEnd,
          bytesUp,
          bytesDown,
        },
      });
      return tx.subscription.update({
        where: { id: protocolUser.subscriptionId },
        data: { dataUsedBytes: { increment: bytesUp + bytesDown } },
      });
    });

    if (subscription.status === "ACTIVE" && subscription.dataUsedBytes >= subscription.dataCapBytes) {
      await this.suspendForQuota(subscription.id);
    }
  }

  /** Suspends a subscription and hot-disables every one of its active
   * ProtocolUsers. Idempotent (no-ops if already non-ACTIVE) -- safe to
   * call from both the real-time path above and the quota-sweep safety
   * net without double-suspending or double-enqueueing DISABLE_USER. */
  async suspendForQuota(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!subscription || subscription.status !== "ACTIVE") return;

    await this.prisma.subscription.update({ where: { id: subscriptionId }, data: { status: "SUSPENDED" } });
    await this.disableProtocolUsers(subscriptionId);
    this.logger.log(`Subscription ${subscriptionId} suspended: data cap exceeded`);
  }

  async expireSubscription(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!subscription || subscription.status !== "ACTIVE") return;

    await this.prisma.subscription.update({ where: { id: subscriptionId }, data: { status: "EXPIRED" } });
    await this.disableProtocolUsers(subscriptionId);
    this.logger.log(`Subscription ${subscriptionId} expired`);
  }

  private async disableProtocolUsers(subscriptionId: string) {
    const users = await this.prisma.protocolUser.findMany({ where: { subscriptionId, status: "ACTIVE" } });
    for (const user of users) {
      await this.agentGateway.enqueueCommand(user.nodeId, "DISABLE_USER", {
        protocol: user.protocol,
        externalUserId: user.externalUserId,
      });
      await this.prisma.protocolUser.update({ where: { id: user.id }, data: { status: "DISABLED" } });
    }
  }

  /** Safety net for the real-time cap check in recordOne() -- catches
   * subscriptions whose reporting node was offline (or whose StatsBatch
   * was lost) when the cap was actually crossed. Column-to-column
   * comparison (dataUsedBytes >= dataCapBytes) isn't expressible in a
   * single Prisma where-clause, so it's filtered in code after fetching
   * ACTIVE subscriptions -- fine at this data scale. */
  async sweepQuota(): Promise<number> {
    const active = await this.prisma.subscription.findMany({ where: { status: "ACTIVE" } });
    const overCap = active.filter((s) => s.dataUsedBytes >= s.dataCapBytes);
    for (const s of overCap) {
      await this.suspendForQuota(s.id);
    }
    return overCap.length;
  }

  async sweepExpiry(): Promise<number> {
    const expired = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE", expireAt: { lt: new Date() } },
    });
    for (const s of expired) {
      await this.expireSubscription(s.id);
    }
    return expired.length;
  }
}

function isProtocol(value: string): value is Protocol {
  return (Object.values(Protocol) as string[]).includes(value);
}
