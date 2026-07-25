import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { decryptCredentials } from "../protocol-users/credentials-crypto";

export interface SessionCountInput {
  externalUserId: string;
  protocol: string;
  distinctSources: number;
}

/** Reports must exceed the limit this many times running before anything
 * is disconnected.
 *
 * A single over-limit reading is not evidence of sharing. Someone moving
 * from wifi to mobile data, or a laptop waking on a new network, briefly
 * shows two addresses. Requiring it to persist across consecutive polls
 * (~30s apart) distinguishes "changed network" from "two people". */
const STRIKES_BEFORE_ACTION = 3;

/** How long a disconnected user stays disconnected.
 *
 * Long enough that reconnecting everything at once doesn't immediately
 * trip the limit again, short enough that a customer who simply had a
 * bad reading isn't locked out meaningfully. */
const COOLDOWN_MS = 60_000;

/** Enforces a plan's concurrent-connection limit.
 *
 * Only Xray is enforced here, because only Xray needs it. VLESS accepts
 * unlimited simultaneous connections for one UUID, so a shared credential
 * genuinely multiplies into many users. The other engines are already
 * self-limiting: OpenVPN replaces the existing session when the same
 * certificate reconnects (no duplicate-cn), and a WireGuard peer holds a
 * single endpoint, so devices sharing a key fight over it instead of
 * working in parallel. Nodes report counts only for protocols they can
 * actually measure, and a protocol that reports nothing is treated as
 * unknown rather than as zero.
 */
@Injectable()
export class ConcurrencyService implements OnModuleDestroy {
  private readonly logger = new Logger(ConcurrencyService.name);

  /** Consecutive over-limit readings per protocol user. Held in memory
   * on purpose: it is a debounce, not a record. Losing it on restart
   * costs at most a couple of extra polls before a real sharer trips it
   * again, which is cheaper than writing to the database every 30s. */
  private readonly strikes = new Map<string, number>();
  /** Users disconnected recently, so a burst of reports doesn't disconnect
   * the same person repeatedly while they are still reconnecting. */
  private readonly cooldownUntil = new Map<string, number>();
  /** Scheduled restores, tracked so shutdown can cancel them. */
  private readonly pendingReenables = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGatewayService,
  ) {}

  async handleSessionCounts(nodeId: string, counts: SessionCountInput[]) {
    for (const count of counts) {
      await this.evaluate(nodeId, count);
    }
  }

  private async evaluate(nodeId: string, count: SessionCountInput) {
    const user = await this.prisma.protocolUser.findFirst({
      where: { nodeId, externalUserId: count.externalUserId },
      include: { subscription: { include: { plan: true } } },
    });
    // Unknown to us, already disabled, or on a plan with no limit set --
    // an unset limit means unlimited, not zero.
    if (!user || user.status !== "ACTIVE") return;
    const limit = user.subscription?.plan?.maxConcurrentConnections;
    if (!limit || limit <= 0) return;

    const key = `${nodeId}:${count.externalUserId}`;

    if (count.distinctSources <= limit) {
      // Back within the limit: forget the history rather than letting
      // strikes accumulate across unrelated incidents hours apart.
      this.strikes.delete(key);
      return;
    }

    const until = this.cooldownUntil.get(key);
    if (until && Date.now() < until) return;

    const strikes = (this.strikes.get(key) ?? 0) + 1;
    this.strikes.set(key, strikes);
    if (strikes < STRIKES_BEFORE_ACTION) {
      this.logger.debug(
        `${count.externalUserId} on node ${nodeId} is at ${count.distinctSources}/${limit} connections (${strikes}/${STRIKES_BEFORE_ACTION})`,
      );
      return;
    }

    this.strikes.delete(key);
    this.cooldownUntil.set(key, Date.now() + COOLDOWN_MS);

    this.logger.warn(
      `Disconnecting ${count.externalUserId} on node ${nodeId}: ` +
        `${count.distinctSources} simultaneous sources exceeds the plan's limit of ${limit}`,
    );

    // Dropping the user from the engine is the only lever available:
    // Xray can add and remove a user but cannot close one of their
    // connections, so a single session can't be singled out. Everything
    // for that credential drops and legitimate clients reconnect --
    // which is also what makes the cooldown necessary.
    await this.agentGateway.enqueueCommand(nodeId, "DISABLE_USER", {
      protocol: user.protocol,
      externalUserId: count.externalUserId,
    });

    // Re-enabled after the cooldown, not immediately -- otherwise the
    // disconnect achieves nothing. The subscription itself is untouched:
    // this is a momentary interruption, not a suspension, and the
    // customer's row stays ACTIVE throughout.
    //
    // If this process restarts mid-cooldown the timer is lost, and the
    // periodic re-assert restores the user on its next pass instead.
    // Later than intended, but never permanent.
    const timer = setTimeout(() => {
      this.pendingReenables.delete(key);
      this.agentGateway
        .enqueueCommand(nodeId, "ENABLE_USER", {
          protocol: user.protocol,
          externalUserId: count.externalUserId,
          credentials: decryptCredentials(user.credentialsJson),
        })
        .catch((err) => this.logger.error(`Failed to restore ${count.externalUserId}: ${err}`));
    }, COOLDOWN_MS);
    // Unref'd so a pending re-enable can't keep the process alive during
    // a shutdown.
    timer.unref?.();
    this.pendingReenables.set(key, timer);
  }

  onModuleDestroy() {
    for (const timer of this.pendingReenables.values()) clearTimeout(timer);
  }
}
