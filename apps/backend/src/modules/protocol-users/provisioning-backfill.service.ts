import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { after, forEachBatch } from "../../common/batching";
import { PrismaService } from "../../prisma/prisma.service";
import { ProtocolUsersService } from "./protocol-users.service";

/** Brings every live subscription up to the full set of credentials its
 * plan entitles it to, once, at boot.
 *
 * Failover can only use a protocol the client already holds, and
 * provisionAll otherwise runs only at moments that may be a month away
 * -- a payment, a renewal, a new route. Without this, the customers who
 * have been here longest would be the ones with the fewest ways out of a
 * block, which is exactly backwards and invisible until one of them is
 * blocked.
 *
 * Boot is the trigger because it is the one moment that reliably happens
 * after a deploy that adds a protocol, and it needs no credentials of
 * its own -- an admin-only endpoint would need someone to hold a token
 * and remember to call it.
 *
 * Cheap to repeat, but no longer only additive. provisionAll reconciles
 * in both directions now: it adds the routes a plan allows and REVOKES
 * the credentials it does not, issuing DELETE_USER to the node. So once
 * the fleet is caught up this is a handful of queries and no commands --
 * but the first boot after a plan's rules change is a destructive sweep,
 * not a top-up. On 2026-08-16 that boot revoked 36 credentials: 32 from
 * two Ultimate subscriptions still holding direct routes from before
 * relayOnly existed, and 6 from two Starter subscriptions.
 *
 * That is the intended behaviour -- a rule the customers who predate it
 * are exempt from is not a rule -- but it is worth knowing that this
 * service is the thing that usually applies it, at the least expected
 * moment. Revocation keys off plan policy and never off whether a route
 * happens to be reachable, so a route disabled for maintenance does not
 * cause one (see provisionAll).
 *
 * It runs detached from startup so a slow or failing sweep can never
 * stop the API coming up.
 */
@Injectable()
export class ProvisioningBackfillService implements OnModuleInit {
  private readonly logger = new Logger(ProvisioningBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly protocolUsersService: ProtocolUsersService,
  ) {}

  onModuleInit() {
    void this.run().catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Provisioning backfill failed: ${reason}`);
    });
  }

  async run() {
    // SUSPENDED is included deliberately: a subscription over its data
    // cap still exists and will come back on renewal, and provisioning
    // does not grant access on its own -- the credentials stay disabled
    // until renewSubscription re-enables them.
    let considered = 0;
    let added = 0;
    let revoked = 0;
    let failed = 0;

    // Cursored rather than read in one go. This one is not self-draining
    // -- a subscription is still ACTIVE after it has been provisioned --
    // so the cursor is what makes progress at all, and it is the reason a
    // `take` would have been silently wrong here rather than merely
    // partial.
    await forEachBatch({
      label: "provisioningBackfill",
      read: (afterId, take) =>
        this.prisma.subscription.findMany({
          where: { status: { in: ["ACTIVE", "SUSPENDED"] }, ...after(afterId) },
          select: { id: true },
          orderBy: { id: "asc" },
          take,
        }),
      handle: async (batch) => {
        for (const subscription of batch) {
          considered += 1;
          try {
            const result = await this.protocolUsersService.provisionAll(subscription.id);
            added += result.created.length;
            revoked += result.revoked.length;
          } catch (err) {
            failed += 1;
            const reason = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Backfill skipped subscription ${subscription.id}: ${reason}`);
          }
        }
      },
    });

    // Silent when there was nothing to do, which is the steady state --
    // a line every boot saying "0" is noise that trains you to ignore
    // the line that matters.
    //
    // `revoked` is part of that condition, not just part of the message.
    // Without it a boot that deleted credentials and created none would
    // print nothing at all: the most destructive sweep this service can
    // perform would be its quietest. Reported at warn rather than log
    // when anything was revoked, because a sweep that removed a
    // customer's access is not routine even when it is correct.
    if (added > 0 || revoked > 0 || failed > 0) {
      const summary =
        `Provisioning backfill: added ${added} credential(s), revoked ${revoked}, ` +
        `across ${considered} subscription(s)` +
        (failed > 0 ? `, ${failed} skipped` : "");
      if (revoked > 0) {
        this.logger.warn(summary);
      } else {
        this.logger.log(summary);
      }
    }
    return { added, revoked, failed, considered };
  }
}
