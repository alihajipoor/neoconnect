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

  async create(dto: CreateSubscriptionDto) {
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
      },
    });
  }
}
