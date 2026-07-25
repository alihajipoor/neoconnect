import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { rateLimitFor } from "../protocol-users/rate-limit";
import { CreatePlanDto } from "./dto/create-plan.dto";
import { UpdatePlanDto } from "./dto/update-plan.dto";

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGatewayService,
  ) {}

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
    const before = await this.get(id);
    const plan = await this.prisma.subscriptionPlan.update({
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

    if (plan.maxDownloadMbps !== before.maxDownloadMbps || plan.maxUploadMbps !== before.maxUploadMbps) {
      await this.reapplyRateLimits(plan);
    }

    return plan;
  }

  /** Pushes changed speed caps to everyone already on this plan.
   *
   * Without this an admin edits a plan, sees the new number, and nothing
   * happens to any existing customer -- only people provisioned afterwards
   * would get it, which is the opposite of what editing a plan looks like
   * it does.
   *
   * Sent as UPDATE_USER per user, reusing the same per-user hot-update
   * contract every other change goes through, so nothing is restarted and
   * nobody else on the node is disturbed. Credentials are not included:
   * the agent only needs to know who to re-shape, and re-sending secrets
   * that have not changed would widen their exposure for no reason.
   */
  private async reapplyRateLimits(plan: {
    id: string;
    maxDownloadMbps: number | null;
    maxUploadMbps: number | null;
  }) {
    const users = await this.prisma.protocolUser.findMany({
      where: { subscription: { planId: plan.id } },
      select: { nodeId: true, protocol: true, externalUserId: true },
    });

    for (const user of users) {
      await this.agentGateway.enqueueCommand(user.nodeId, "UPDATE_USER", {
        protocol: user.protocol,
        externalUserId: user.externalUserId,
        ...rateLimitFor(plan, user.protocol),
      });
    }
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
