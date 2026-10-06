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
    const switchedOff = await this.switchOffUnpaidCredentials();

    // SUSPENDED is included for the revoking half only. provisionAll adds
    // nothing to a subscription that is not ACTIVE (it used to: a missing
    // route became a fresh, ENABLED credential, which is the opposite of
    // what this comment once claimed), but a route the plan no longer
    // allows is still taken off a suspended subscription now rather than
    // surviving until its renewal.
    let considered = 0;
    let added = 0;
    let revoked = 0;
    let failed = 0;
    let incomplete = 0;

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
            // A route that could not be provisioned no longer throws (see
            // provisionAll); it still makes the subscription one that
            // needs looking at.
            if (result.failed?.length) incomplete += 1;
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
    if (added > 0 || revoked > 0 || failed > 0 || incomplete > 0) {
      const summary =
        `Provisioning backfill: added ${added} credential(s), revoked ${revoked}, ` +
        `across ${considered} subscription(s)` +
        (failed > 0 ? `, ${failed} skipped` : "") +
        (incomplete > 0 ? `, ${incomplete} left short of a route (see the errors above)` : "");
      if (revoked > 0) {
        this.logger.warn(summary);
      } else {
        this.logger.log(summary);
      }
    }
    return { added, revoked, failed, considered, switchedOff };
  }

  /** Takes away the working credentials of subscriptions nobody is paying
   * for.
   *
   * Until provisionAll learned to refuse, a plan's route edit, a plan
   * change or this very backfill handed an ENABLED credential to every
   * PENDING, CANCELLED, EXPIRED or SUSPENDED subscription short of a
   * route, and nothing ever switched one off: quota and expiry act on
   * ACTIVE subscriptions only, and the re-assert kept them on their nodes.
   * Stopping new ones is not enough -- the ones already out there are
   * live access somebody did not pay for.
   *
   * An unpaid attempt's credentials (PENDING, CANCELLED) are removed
   * outright: DELETE_USER, and the WireGuard address goes back to the
   * pool. If the attempt is paid after all, renewSubscription provisions
   * it from scratch. A lapsed subscription's (EXPIRED, SUSPENDED) are only
   * switched off, exactly as expiry and suspension do, so renewal turns
   * the same credentials back on.
   *
   * Every row is handled on its own and a failure is logged, not thrown:
   * one node that cannot be told must not keep the rest switched on.
   * Steady state is no rows and no output. */
  async switchOffUnpaidCredentials() {
    let removed = 0;
    let disabled = 0;
    let failed = 0;

    await forEachBatch({
      label: "unpaidCredentialSweep",
      read: (afterId, take) =>
        this.prisma.protocolUser.findMany({
          where: { status: "ACTIVE", subscription: { status: { not: "ACTIVE" } }, ...after(afterId) },
          select: { id: true, subscription: { select: { status: true } } },
          orderBy: { id: "asc" },
          take,
        }),
      handle: async (batch) => {
        for (const user of batch) {
          const unpaid = user.subscription.status === "PENDING" || user.subscription.status === "CANCELLED";
          try {
            if (unpaid) {
              await this.protocolUsersService.remove(user.id);
              removed += 1;
            } else {
              await this.protocolUsersService.setEnabled(user.id, false);
              disabled += 1;
            }
          } catch (err) {
            failed += 1;
            const reason = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Could not switch off credential ${user.id} of a ${user.subscription.status} subscription: ${reason}`);
          }
        }
      },
    });

    if (removed > 0 || disabled > 0 || failed > 0) {
      this.logger.warn(
        `Switched off credentials of subscriptions that are not ACTIVE: removed ${removed} ` +
          `(PENDING/CANCELLED), disabled ${disabled} (EXPIRED/SUSPENDED)` +
          (failed > 0 ? `, ${failed} could not be (see above)` : ""),
      );
    }
    return { removed, disabled, failed };
  }
}
