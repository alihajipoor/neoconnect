import { forwardRef, Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { ConcurrencyStore } from "./concurrency-store";
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

/** The shortest gap between two strikes against the same subscription.
 *
 * Strikes are meant to count polling *cycles*, and they did while one
 * node reported. Now that several nodes report the same subscription
 * independently, five nodes would land three strikes in a few seconds
 * and act on what is still a single reading -- turning a deliberate
 * ~90-second debounce into no debounce at all, on exactly the customers
 * who use the most locations.
 *
 * Twenty seconds is comfortably inside a ~30s report interval, so an
 * honest cycle still counts, while a burst from several nodes counts
 * once. */
const MIN_STRIKE_GAP_MS = 20_000;

/** Enforces a plan's concurrent-connection limit.
 *
 * Xray exposes session counts nowhere in its API -- its stats report
 * bytes, not connections -- so the agent derives them by reading the
 * access log. That makes this class only as alive as the log is.
 *
 * It was turned off fleet-wide on 2026-08-16 for privacy and turned
 * back on on 2026-08-17 when the cost became clear: with it off,
 * Starter's one device and Pro's two were decorative on REALITY,
 * VLESS+TLS over TCP and WS, Trojan and Shadowsocks -- the six
 * protocols Iranian customers actually use. The log is on now, carrying
 * source addresses and user tags, one day's retention.
 *
 * So the mechanism is live. What has NOT been done is watching it act:
 * nobody has put two devices on one credential and seen a disconnect.
 * Treat enforcement as restored-but-unproven until someone has.
 *
 * Also enforced without any counting, and unaffected by the above:
 * OpenVPN replaces the existing session when the same certificate
 * reconnects, and a WireGuard peer holds one endpoint, so devices
 * sharing a key fight over it rather than working in parallel.
 *
 * The limit is evaluated per subscription, not per credential -- see
 * handleSessionCounts for why that distinction is what makes it
 * enforceable at all.
 *
 * A protocol that reports nothing is treated as unknown rather than as
 * zero, so a node that cannot measure never causes a disconnect.
 */
@Injectable()
export class ConcurrencyService implements OnModuleDestroy {
  private readonly logger = new Logger(ConcurrencyService.name);

  /** Consecutive over-limit readings per subscription. Held in memory
   * on purpose: it is a debounce, not a record. Losing it on restart
   * costs at most a couple of extra polls before a real sharer trips it
   * again, which is cheaper than writing to the database every 30s. */
  private readonly strikes = new Map<string, number>();
  /** Users disconnected recently, so a burst of reports doesn't disconnect
   * the same person repeatedly while they are still reconnecting. */
  private readonly cooldownUntil = new Map<string, number>();
  /** When each subscription last took a strike, so a burst of reports
   * from different nodes counts as one. See MIN_STRIKE_GAP_MS. */
  private readonly lastStrikeAt = new Map<string, number>();
  /** Scheduled restores, tracked so shutdown can cancel them. */
  private readonly pendingReenables = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    // UsageModule and AgentGatewayModule import each other, so the
    // parameter needs its own forwardRef as well as the module-level one
    // -- without it Nest cannot resolve this at boot (UsageService, the
    // other consumer of the same service, already does this).
    @Inject(forwardRef(() => AgentGatewayService))
    private readonly agentGateway: AgentGatewayService,
    private readonly store: ConcurrencyStore,
  ) {}

  /** One node's report, aggregated per subscription before judging it.
   *
   * Aggregation is the point. The limit belongs to the customer, not to
   * a credential, and since every subscription is now provisioned on
   * every route its plan allows, judging each credential separately gave
   * a sharer the limit once per protocol -- five times over on a node
   * running five inbounds, with nothing anywhere reporting it.
   *
   * Summing is sound because a device connects on one protocol at a
   * time, so a legitimate customer contributes one source however many
   * credentials they hold.
   *
   * The total is then taken across the whole fleet, not just this node.
   * Per-node was the obvious hole once every subscription gained a
   * credential on every route: a sharer only had to give each friend a
   * different location, and a limit of two across five nodes quietly
   * permitted ten. ConcurrencyStore holds each node's latest count so
   * the limit means what it says on the plan.
   */
  async handleSessionCounts(nodeId: string, counts: SessionCountInput[]) {
    const bySubscription = new Map<string, { sources: number; protocol: string }>();

    for (const count of counts) {
      const user = await this.prisma.protocolUser.findFirst({
        where: { nodeId, externalUserId: count.externalUserId },
        select: { status: true, protocol: true, subscriptionId: true },
      });
      // Unknown to us, or already switched off -- a disabled credential's
      // lingering sessions must not count against the customer.
      if (!user || user.status !== 'ACTIVE') continue;

      const seen = bySubscription.get(user.subscriptionId);
      bySubscription.set(user.subscriptionId, {
        sources: (seen?.sources ?? 0) + count.distinctSources,
        protocol: seen?.protocol ?? user.protocol,
      });
    }

    for (const [subscriptionId, { sources }] of bySubscription) {
      const total = await this.store.recordAndTotal(subscriptionId, nodeId, sources);
      await this.evaluate(subscriptionId, total);
    }
  }

  private async evaluate(subscriptionId: string, distinctSources: number) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: true },
    });
    // An unset limit means unlimited, not zero.
    const limit = subscription?.plan?.maxConcurrentConnections;
    if (!limit || limit <= 0) return;

    const key = subscriptionId;

    if (distinctSources <= limit) {
      // Back within the limit: forget the history rather than letting
      // strikes accumulate across unrelated incidents hours apart.
      this.strikes.delete(key);
      this.lastStrikeAt.delete(key);
      return;
    }

    const until = this.cooldownUntil.get(key);
    if (until && Date.now() < until) return;

    // One strike per cycle however many nodes report it.
    const lastStrike = this.lastStrikeAt.get(key);
    if (lastStrike && Date.now() - lastStrike < MIN_STRIKE_GAP_MS) return;
    this.lastStrikeAt.set(key, Date.now());

    const strikes = (this.strikes.get(key) ?? 0) + 1;
    this.strikes.set(key, strikes);
    if (strikes < STRIKES_BEFORE_ACTION) {
      this.logger.debug(
        `Subscription ${subscriptionId} is at ${distinctSources}/${limit} connections (${strikes}/${STRIKES_BEFORE_ACTION})`,
      );
      return;
    }

    this.strikes.delete(key);
    this.lastStrikeAt.delete(key);
    this.cooldownUntil.set(key, Date.now() + COOLDOWN_MS);

    // The stored counts describe sessions that are about to stop
    // existing. Left in place they would survive the disconnect for a
    // minute and a half and re-trip the limit the moment the customer's
    // legitimate devices came back.
    await this.store.clear(subscriptionId);

    // Every credential, not only the one that reported over the limit.
    // Dropping just that one would move the sharer onto the next
    // protocol they already hold -- the same hole one step along.
    const users = await this.prisma.protocolUser.findMany({
      where: { subscriptionId, status: 'ACTIVE' },
    });

    this.logger.warn(
      `Disconnecting subscription ${subscriptionId}: ${distinctSources} simultaneous sources ` +
        `exceeds the plan's limit of ${limit} (${users.length} credentials dropped)`,
    );

    // Dropping the user from the engine is the only lever available:
    // Xray can add and remove a user but cannot close one of their
    // connections, so a single session can't be singled out. Everything
    // for that credential drops and legitimate clients reconnect --
    // which is also what makes the cooldown necessary.
    for (const user of users) {
      await this.agentGateway.enqueueCommand(user.nodeId, 'DISABLE_USER', {
        protocol: user.protocol,
        externalUserId: user.externalUserId,
      });
    }

    // Re-enabled after the cooldown, not immediately -- otherwise the
    // disconnect achieves nothing. The subscription itself is untouched:
    // this is a momentary interruption, not a suspension, and the
    // customer's row stays ACTIVE throughout.
    //
    // If this process restarts mid-cooldown the timer is lost, and the
    // periodic re-assert restores the users on its next pass instead.
    // Later than intended, but never permanent.
    const timer = setTimeout(() => {
      this.pendingReenables.delete(key);
      for (const user of users) {
        this.agentGateway
          .enqueueCommand(user.nodeId, 'ENABLE_USER', {
            protocol: user.protocol,
            externalUserId: user.externalUserId,
            credentials: decryptCredentials(user.credentialsJson),
          })
          .catch((err) => this.logger.error(`Failed to restore ${user.externalUserId}: ${err}`));
      }
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
