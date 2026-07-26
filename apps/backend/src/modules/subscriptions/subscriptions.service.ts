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
