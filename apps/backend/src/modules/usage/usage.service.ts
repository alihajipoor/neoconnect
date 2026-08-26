import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { Protocol } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { EmailService } from "../email/email.service";
import { lowDataWarningEmail, expiringSoonEmail } from "../email/templates";

export interface UsageDeltaInput {
  externalUserId: string;
  protocol: string;
  bytesUp: string;
  bytesDown: string;
}

const BYTES_PER_GB = 1_073_741_824n;
// The user's own stated example ("1GB left") -- fires once per billing
// period, tracked by Subscription.lowDataWarningSentAt.
const LOW_DATA_WARNING_THRESHOLD_BYTES = 1n * BYTES_PER_GB;
const EXPIRY_WARNING_THRESHOLD_DAYS = 3;

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
    private readonly emailService: EmailService,
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

    // Matched on the external id alone, not on the reported protocol.
    //
    // A node running several inbounds in one engine cannot always say
    // which of them a byte belongs to: Xray keeps usage per user, so the
    // agent reports every Xray user under whichever Xray protocol
    // happens to be doing the reporting. Requiring the label to match
    // meant those deltas found no row and were dropped in silence --
    // customers using a second Xray protocol accrued no usage at all
    // against their cap.
    //
    // The label is still worth carrying for diagnostics, but it earns
    // nothing here: externalUserId is a UUID, a WireGuard public key or
    // a certificate name, so it identifies the row on its own.
    const protocolUser = await this.prisma.protocolUser.findFirst({
      where: { nodeId, externalUserId: delta.externalUserId },
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

    // A null cap is unlimited, so there is nothing to cross. Checked
    // explicitly rather than relying on the comparison: `x >= null`
    // coerces to `x >= 0` in JS and would suspend every unlimited
    // subscription on its first byte.
    if (
      subscription.status === "ACTIVE" &&
      subscription.dataCapBytes !== null &&
      subscription.dataUsedBytes >= subscription.dataCapBytes
    ) {
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
    const active = await this.prisma.subscription.findMany({
      // Unlimited subscriptions can never be over cap, so they do not
      // even need fetching.
      where: { status: "ACTIVE", dataCapBytes: { not: null } },
      // Three columns rather than the row. This sweep reads every capped
      // active subscription in one go and the comparison it exists to
      // make needs exactly these; the rest was being pulled into memory
      // for a filter that never looked at it.
      select: { id: true, dataCapBytes: true, dataUsedBytes: true },
    });
    const overCap = active.filter((s) => s.dataCapBytes !== null && s.dataUsedBytes >= s.dataCapBytes);
    for (const s of overCap) {
      await this.suspendForQuota(s.id);
    }
    return overCap.length;
  }

  async sweepExpiry(): Promise<number> {
    const expired = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE", expireAt: { lt: new Date() } },
      select: { id: true },
    });
    for (const s of expired) {
      await this.expireSubscription(s.id);
    }
    return expired.length;
  }

  /** M16 trigger #3: warns a customer once per billing period when their
   * remaining data drops under the threshold. `lowDataWarningSentAt` is
   * the "already warned" flag (reset to null on renewal, see
   * BillingService.renewSubscription()) so this fires exactly once. */
  async sweepLowDataWarnings(): Promise<number> {
    const candidates = await this.prisma.subscription.findMany({
      // No cap, no "running low" -- there is nothing to run low on.
      where: { status: "ACTIVE", lowDataWarningSentAt: null, dataCapBytes: { not: null } },
      // `include: { customer: true }` here meant every candidate's
      // `passwordHash`, `tokenVersion`, `emailVerificationCode` and
      // `passwordResetCode` were read into the sweep's memory so it could
      // use one field: the address to send to.
      select: {
        id: true,
        dataCapBytes: true,
        dataUsedBytes: true,
        customer: { select: { email: true } },
      },
    });
    const nearCap = candidates.filter(
      (s) =>
        s.dataCapBytes !== null &&
        s.dataUsedBytes < s.dataCapBytes &&
        s.dataCapBytes - s.dataUsedBytes <= LOW_DATA_WARNING_THRESHOLD_BYTES,
    );
    for (const s of nearCap) {
      const remainingGb = Number(s.dataCapBytes! - s.dataUsedBytes) / Number(BYTES_PER_GB);
      await this.emailService.sendMail({ to: s.customer.email, ...lowDataWarningEmail(remainingGb) });
      await this.prisma.subscription.update({ where: { id: s.id }, data: { lowDataWarningSentAt: new Date() } });
    }
    return nearCap.length;
  }

  /** M16 trigger #4: same "already warned" shape as above, via
   * `expiryWarningSentAt`. */
  async sweepExpiryWarnings(): Promise<number> {
    const now = new Date();
    const threshold = new Date(now.getTime() + EXPIRY_WARNING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
    const soon = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE", expiryWarningSentAt: null, expireAt: { gt: now, lte: threshold } },
      // Same narrowing as the low-data sweep above, and for the same
      // reason: the only thing wanted off the customer is where to send.
      select: { id: true, expireAt: true, customer: { select: { email: true } } },
    });
    for (const s of soon) {
      const daysRemaining = Math.max(1, Math.ceil((s.expireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
      await this.emailService.sendMail({ to: s.customer.email, ...expiringSoonEmail(daysRemaining) });
      await this.prisma.subscription.update({ where: { id: s.id }, data: { expiryWarningSentAt: new Date() } });
    }
    return soon.length;
  }
}

function isProtocol(value: string): value is Protocol {
  return (Object.values(Protocol) as string[]).includes(value);
}
