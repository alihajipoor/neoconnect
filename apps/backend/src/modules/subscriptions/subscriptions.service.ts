import { SubscriptionStatus } from "@prisma/client";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateSubscriptionDto } from "./dto/create-subscription.dto";

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

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
