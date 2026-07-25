import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CreatePlanDto } from "./dto/create-plan.dto";
import { UpdatePlanDto } from "./dto/update-plan.dto";

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.subscriptionPlan.findMany({ orderBy: { priceUsd: "asc" } });
  }

  /** Customer-facing: only plans that are actually purchasable right now
   * -- used by CustomerController, never the admin-only routes above
   * (which intentionally show inactive plans too, for management). */
  listActive() {
    return this.prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { priceUsd: "asc" },
    });
  }

  async get(id: string) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id } });
    if (!plan) {
      throw new NotFoundException("Plan not found");
    }
    return plan;
  }

  create(dto: CreatePlanDto) {
    return this.prisma.subscriptionPlan.create({
      data: {
        name: dto.name,
        dataCapBytes: BigInt(dto.dataCapBytes),
        durationDays: dto.durationDays,
        priceUsd: dto.priceUsd,
        maxConcurrentConnections: dto.maxConcurrentConnections,
        maxDownloadMbps: dto.maxDownloadMbps,
        maxUploadMbps: dto.maxUploadMbps,
        protocolsAllowed: dto.protocolsAllowed,
        isActive: dto.isActive ?? true,
        defaultRouteId: dto.defaultRouteId,
      },
    });
  }

  async update(id: string, dto: UpdatePlanDto) {
    await this.get(id);
    return this.prisma.subscriptionPlan.update({
      where: { id },
      data: {
        name: dto.name,
        dataCapBytes: dto.dataCapBytes !== undefined ? BigInt(dto.dataCapBytes) : undefined,
        durationDays: dto.durationDays,
        priceUsd: dto.priceUsd,
        maxConcurrentConnections: dto.maxConcurrentConnections,
        maxDownloadMbps: dto.maxDownloadMbps,
        maxUploadMbps: dto.maxUploadMbps,
        protocolsAllowed: dto.protocolsAllowed,
        isActive: dto.isActive,
        defaultRouteId: dto.defaultRouteId,
      },
    });
  }

  /** A bare `prisma.subscriptionPlan.delete()` 500s (unhandled Prisma FK
   * violation) if any Subscription still references this plan, or if
   * it's currently set as FreeTrialSettings.trialPlanId -- both are
   * real, meaningful state (billing history / live trial config), so
   * this blocks with a clear message rather than silently cascading
   * anything. */
  async remove(id: string) {
    await this.get(id);

    const [subscriptionCount, trialSettings] = await Promise.all([
      this.prisma.subscription.count({ where: { planId: id } }),
      this.prisma.freeTrialSettings.findFirst({ where: { trialPlanId: id } }),
    ]);
    if (subscriptionCount > 0) {
      throw new BadRequestException(
        `Cannot delete this plan -- ${subscriptionCount} subscription(s) still reference it.`,
      );
    }
    if (trialSettings) {
      throw new BadRequestException(
        "Cannot delete this plan -- it's currently configured as the free trial plan. Change that in Settings first.",
      );
    }

    await this.prisma.subscriptionPlan.delete({ where: { id } });
  }
}
