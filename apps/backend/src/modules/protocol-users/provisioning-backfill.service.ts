import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
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
 * Cheap to repeat: provisionAll only fills gaps, so once the fleet is
 * caught up this is a handful of queries and no commands at all. It runs
 * detached from startup so a slow or failing sweep can never stop the
 * API coming up.
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
    const subscriptions = await this.prisma.subscription.findMany({
      where: { status: { in: ["ACTIVE", "SUSPENDED"] } },
      select: { id: true },
    });

    let added = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      try {
        added += (await this.protocolUsersService.provisionAll(subscription.id)).length;
      } catch (err) {
        failed += 1;
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Backfill skipped subscription ${subscription.id}: ${reason}`);
      }
    }

    // Silent when there was nothing to do, which is the steady state --
    // a line every boot saying "0" is noise that trains you to ignore
    // the line that matters.
    if (added > 0 || failed > 0) {
      this.logger.log(
        `Provisioning backfill: added ${added} credential(s) across ${subscriptions.length} subscription(s)` +
          (failed > 0 ? `, ${failed} skipped` : ""),
      );
    }
    return { added, failed, considered: subscriptions.length };
  }
}
