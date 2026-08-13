import { SubscriptionStatus } from "@prisma/client";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { CreateSubscriptionDto } from "./dto/create-subscription.dto";

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly protocolUsers: ProtocolUsersService,
  ) {}

  /** Gives a customer a plan, ready to use.
   *
   * `create()` on its own writes the row and stops -- it does not
   * provision anything, because the purchase flow provisions later,
   * when the payment clears. An operator assigning a plan by hand has
   * no such second step, so a subscription created that way would look
   * correct in the panel and leave the customer unable to connect.
   * This is create-and-provision, which is what "assign a plan"
   * actually means. */
  async assign(customerId: string, planId: string) {
    const subscription = await this.create({ customerId, planId });
    await this.protocolUsers.provisionAll(subscription.id);
    return this.get(subscription.id);
  }

  /** Moves an existing subscription onto a different plan.
   *
   * The data cap is re-snapshotted, because the subscription carries
   * its own copy rather than reading through to the plan -- that is
   * what stops a later plan edit rewriting what someone already
   * bought, and it means a plan change has to update it explicitly.
   *
   * Credentials are then topped up for whatever the new plan allows.
   * A plan that permits more protocols than the old one needs the
   * extra ones provisioned or the customer simply cannot use what they
   * were moved onto. provisionAll only adds what is missing, so this is
   * safe to run on a subscription that already has most of them.
   *
   * The expiry is left alone. Changing plan is not the same as renewing
   * it, and silently moving somebody's end date -- in either direction
   * -- is not something to infer. */
  async changePlan(id: string, planId: string) {
    await this.get(id);
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new BadRequestException("Plan not found");
    if (!plan.isActive) throw new BadRequestException("Plan is not active");

    await this.prisma.subscription.update({
      where: { id },
      data: {
        planId,
        dataCapBytes: plan.dataCapBytes,
        // The old cap's warning has nothing to say about the new one.
        lowDataWarningSentAt: null,
      },
    });
    await this.protocolUsers.provisionAll(id);
    return this.get(id);
  }

  /** Sets a subscription's status and brings the nodes in line with it.
   *
   * The second half is the part that matters and the part that is easy
   * to leave out: a subscription marked SUSPENDED whose credentials are
   * still enabled is a customer who carries on using the service. The
   * database would say suspended and the node would disagree, which is
   * the worse of the two to be wrong about.
   *
   * Only ACTIVE leaves credentials enabled. Suspended, expired and
   * cancelled all mean "cannot connect", so they all disable. */
  async setStatus(id: string, status: SubscriptionStatus) {
    await this.get(id);
    const enabled = status === SubscriptionStatus.ACTIVE;

    await this.prisma.subscription.update({ where: { id }, data: { status } });
    await this.applyEnabled(id, enabled);
    return this.get(id);
  }

  /** Moves the expiry out by a number of days.
   *
   * Extends from whichever is later, now or the current expiry, so
   * extending an already-lapsed subscription gives the full period
   * rather than silently burning most of it on time already past.
   *
   * Reactivating is deliberately not folded in here. An operator
   * extending a suspended subscription has not necessarily decided to
   * un-suspend it, and guessing wrong would put someone back online who
   * was taken off on purpose. Status is its own action. */
  async extend(id: string, days: number) {
    const subscription = await this.get(id);
    const from = Math.max(Date.now(), subscription.expireAt.getTime());
    const expireAt = new Date(from + days * 86_400_000);

    await this.prisma.subscription.update({
      where: { id },
      // The expiry warning is about the old date and would otherwise
      // never fire again for the new one.
      data: { expireAt, expiryWarningSentAt: null },
    });
    return this.get(id);
  }

  /** Zeroes the usage counter for the current period.
   *
   * Does not touch status, for the same reason extend does not: a
   * subscription can be suspended for reasons other than its data cap,
   * and resurrecting one that was suspended deliberately would be a
   * surprise. The append-only UsageRecord history is untouched -- this
   * resets the counter the cap is compared against, not the record of
   * what was used. */
  async resetUsage(id: string) {
    await this.get(id);
    await this.prisma.subscription.update({
      where: { id },
      data: { dataUsedBytes: 0, lowDataWarningSentAt: null },
    });
    return this.get(id);
  }

  /** Removes a subscription and the credentials it provisioned.
   *
   * Credentials first, so each one gets its DELETE_USER command to the
   * node it lives on. Dropping the subscription row first would orphan
   * them: the rows would go, and the users would carry on existing in
   * the engines with nothing left to say they should not. */
  /**
   * Delete a subscription and everything that cannot outlive it.
   *
   * This used to be a bare `subscription.delete()`, which threw a 500 at
   * the operator for any subscription that had ever carried traffic:
   * UsageRecord.subscriptionId is NOT NULL, so Postgres refused the
   * delete on a foreign key. Deleting a fresh subscription worked and
   * deleting a real one did not, which is the worst way for this to
   * fail -- it looks fine until the row actually matters.
   *
   * What happens to each dependent is a deliberate split, not a cascade:
   *
   *   Usage records are deleted. They are per-subscription telemetry and
   *   mean nothing once the subscription is gone. The counter they feed
   *   (dataUsedBytes) goes with the row.
   *
   *   Invoices, payments and voucher redemptions are DETACHED, not
   *   deleted. Those are money and anti-abuse history: an invoice is a
   *   record of a real charge (it keeps planNameSnapshot precisely so it
   *   can stand alone), and a redemption is what stops a one-time code
   *   being spent twice. Deleting a subscription must not quietly erase
   *   either -- that would let a customer re-redeem a used voucher.
   *
   * Protocol users are removed first and outside the transaction,
   * because removing one enqueues a DELETE_USER for the node: the
   * credential has to stop working on the server, not merely disappear
   * from our database. Doing it first means a failure part-way leaves
   * credentials revoked and the row still present -- recoverable and
   * safe -- rather than the row gone and the credential still live.
   */
  async remove(id: string) {
    await this.get(id);

    const users = await this.prisma.protocolUser.findMany({ where: { subscriptionId: id } });
    for (const user of users) {
      await this.protocolUsers.remove(user.id);
    }

    await this.prisma.$transaction([
      this.prisma.usageRecord.deleteMany({ where: { subscriptionId: id } }),
      this.prisma.invoice.updateMany({ where: { subscriptionId: id }, data: { subscriptionId: null } }),
      this.prisma.paymentTransaction.updateMany({
        where: { subscriptionId: id },
        data: { subscriptionId: null },
      }),
      this.prisma.voucherRedemption.updateMany({
        where: { subscriptionId: id },
        data: { subscriptionId: null },
      }),
      this.prisma.subscription.delete({ where: { id } }),
    ]);

    return { deleted: true };
  }

  private async applyEnabled(subscriptionId: string, enabled: boolean) {
    const users = await this.prisma.protocolUser.findMany({ where: { subscriptionId } });
    for (const user of users) {
      // Already in the wanted state: skip rather than enqueue a command
      // the node would only have to ignore.
      const alreadyRight = enabled ? user.status === "ACTIVE" : user.status === "DISABLED";
      if (alreadyRight) continue;
      await this.protocolUsers.setEnabled(user.id, enabled);
    }
  }

  list() {
    return this.prisma.subscription.findMany({ orderBy: { createdAt: "desc" } });
  }

  /** Customer-facing: only this customer's own subscriptions -- used by
   * CustomerController, never exposed via the admin-only routes above. */
  listByCustomer(customerId: string) {
    return this.prisma.subscription.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { id } });
    if (!subscription) {
      throw new NotFoundException("Subscription not found");
    }
    return subscription;
  }

  /** Customer-facing ownership check -- used before letting a customer
   * kick off a payment against a subscription (`POST
   * /customer/billing/payments`), so one customer can't pay off (or
   * otherwise trigger renewal side effects on) another customer's
   * subscription by guessing/enumerating IDs. Deliberately throws the
   * same NotFoundException as a missing ID rather than a
   * ForbiddenException, so a caller can't distinguish "doesn't exist"
   * from "exists but isn't yours" by probing IDs. */
  async getOwned(id: string, customerId: string) {
    const subscription = await this.get(id);
    if (subscription.customerId !== customerId) {
      throw new NotFoundException("Subscription not found");
    }
    return subscription;
  }

  /** `status` is explicit because the three callers mean different
   * things. A customer picking a plan has not paid yet and must start
   * PENDING; a free trial and an admin-created subscription are live
   * immediately. The column default was ACTIVE, which silently made
   * "clicked a plan and closed the payment window" look identical to
   * "paying customer" in the panel. */
  /** The customer self-purchase entry point: reuse an unpaid attempt at
   * the same plan rather than starting a new one.
   *
   * Every press of Card or Crypto used to create a fresh subscription
   * before the payment was even attempted, so a customer whose payment
   * failed -- or who simply changed their mind about the method -- left a
   * PENDING row behind each time. Four test purchases produced four
   * subscriptions.
   *
   * Reuse is keyed on customer+plan+PENDING, which is exactly the
   * "I'm still trying to buy this" case. Switching plans still creates a
   * separate attempt, since that is a different purchase.
   *
   * The dates and cap are refreshed on reuse: the row was never paid for,
   * so it should reflect the plan as it is now, not as it was when the
   * first abandoned attempt happened.
   */
  async createOrReusePending(customerId: string, planId: string) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new BadRequestException("Plan not found");
    if (!plan.isActive) throw new BadRequestException("Plan is not active");

    const existing = await this.prisma.subscription.findFirst({
      where: { customerId, planId, status: SubscriptionStatus.PENDING },
      orderBy: { createdAt: "desc" },
    });

    const expireAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);

    if (existing) {
      return this.prisma.subscription.update({
        where: { id: existing.id },
        data: { expireAt, dataCapBytes: plan.dataCapBytes },
      });
    }

    return this.create({ customerId, planId }, SubscriptionStatus.PENDING);
  }

  /** Cancels unpaid attempts that were abandoned.
   *
   * Without this, every failed or half-finished purchase is a PENDING row
   * that lingers forever -- invisible to the customer, but real clutter in
   * the admin's Subscriptions view and in any revenue query that isn't
   * careful about status. Cancelled rather than deleted so the attempt
   * stays auditable alongside its PaymentTransaction.
   */
  async cancelStalePending(olderThanMs: number) {
    const cutoff = new Date(Date.now() - olderThanMs);
    const { count } = await this.prisma.subscription.updateMany({
      where: { status: SubscriptionStatus.PENDING, createdAt: { lt: cutoff } },
      data: { status: SubscriptionStatus.CANCELLED },
    });
    return count;
  }

  async create(dto: CreateSubscriptionDto, status: SubscriptionStatus = SubscriptionStatus.ACTIVE) {
    const [customer, plan] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: dto.customerId } }),
      this.prisma.subscriptionPlan.findUnique({ where: { id: dto.planId } }),
    ]);
    if (!customer) throw new BadRequestException("Customer not found");
    if (!plan) throw new BadRequestException("Plan not found");
    if (!plan.isActive) throw new BadRequestException("Plan is not active");

    const expireAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);

    return this.prisma.subscription.create({
      data: {
        customerId: dto.customerId,
        planId: dto.planId,
        primaryNodeId: dto.nodeId,
        expireAt,
        dataCapBytes: plan.dataCapBytes,
        autoRenew: dto.autoRenew ?? false,
        status,
      },
    });
  }
}
