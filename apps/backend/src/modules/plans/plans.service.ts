import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Protocol } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { rateLimitFor } from "../protocol-users/rate-limit";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { CreatePlanDto } from "./dto/create-plan.dto";
import { UpdatePlanDto } from "./dto/update-plan.dto";

/** Order-insensitive comparison of two id lists.
 *
 * The panel submits the selection in whatever order the checkboxes were
 * ticked, and Prisma returns it in its own; comparing them directly
 * would report a change on every save and reprovision the whole plan for
 * nothing.
 */
function sameIds(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, i) => id === right[i]);
}

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGatewayService,
    private readonly protocolUsers: ProtocolUsersService,
  ) {}

  // The route selection comes back with every plan read, because the
  // admin form needs it to render which boxes are ticked and there is no
  // separate endpoint for it. Ids only -- the panel already loads the
  // full route list to draw the choices.
  private static readonly withRoutes = { allowedRoutes: { select: { id: true } } };

  list() {
    return this.prisma.subscriptionPlan.findMany({
      orderBy: { priceUsd: "asc" },
      include: PlansService.withRoutes,
    });
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
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id },
      include: PlansService.withRoutes,
    });
    if (!plan) {
      throw new NotFoundException("Plan not found");
    }
    return plan;
  }

  /** The protocols a set of routes is reachable on.
   *
   * protocolsAllowed used to be typed in beside the routes, which meant
   * the same question was asked twice and the two answers could
   * disagree: a plan could allow Trojan while pointing only at
   * WireGuard routes, and the intersection quietly decided what the
   * customer got. Deriving it removes the disagreement entirely.
   *
   * An explicit list is still honoured when one is sent, so the API
   * keeps working for anything that is not the panel.
   */
  private async protocolsFor(routeIds: string[] | undefined, explicit?: Protocol[]) {
    if (explicit?.length) return explicit;
    if (!routeIds?.length) return undefined;
    const routes = await this.prisma.route.findMany({
      where: { id: { in: routeIds } },
      select: { entryProtocolConfig: { select: { protocol: true } } },
    });
    return [...new Set(routes.map((r) => r.entryProtocolConfig.protocol))];
  }

  async create(dto: CreatePlanDto) {
    const protocolsAllowed = await this.protocolsFor(dto.allowedRouteIds, dto.protocolsAllowed);
    return this.prisma.subscriptionPlan.create({
      data: {
        name: dto.name,
        // Null (or omitted) means unlimited.
        dataCapBytes: dto.dataCapBytes == null ? null : BigInt(dto.dataCapBytes),
        durationDays: dto.durationDays,
        priceUsd: dto.priceUsd,
        maxConcurrentConnections: dto.maxConcurrentConnections,
        maxDownloadMbps: dto.maxDownloadMbps,
        maxUploadMbps: dto.maxUploadMbps,
        protocolsAllowed,
        isActive: dto.isActive ?? true,
        defaultRouteId: dto.defaultRouteId,
        allowedRoutes: dto.allowedRouteIds?.length
          ? { connect: dto.allowedRouteIds.map((id) => ({ id })) }
          : undefined,
      },
      include: PlansService.withRoutes,
    });
  }

  async update(id: string, dto: UpdatePlanDto) {
    const before = await this.get(id);
    // Recomputed whenever the route selection changes, so the two can
    // never drift apart. undefined when neither was sent, which leaves
    // the stored value alone.
    const protocolsAllowed = await this.protocolsFor(dto.allowedRouteIds, dto.protocolsAllowed);
    const plan = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: {
        name: dto.name,
        // undefined leaves it alone; explicit null makes it unlimited.
        dataCapBytes:
          dto.dataCapBytes === undefined
            ? undefined
            : dto.dataCapBytes === null
              ? null
              : BigInt(dto.dataCapBytes),
        durationDays: dto.durationDays,
        priceUsd: dto.priceUsd,
        maxConcurrentConnections: dto.maxConcurrentConnections,
        maxDownloadMbps: dto.maxDownloadMbps,
        maxUploadMbps: dto.maxUploadMbps,
        protocolsAllowed,
        isActive: dto.isActive,
        defaultRouteId: dto.defaultRouteId,
        // `set` rather than `connect`, so deselecting actually removes.
        // undefined leaves the selection alone; an explicit empty array
        // clears it back to "no restriction".
        allowedRoutes: dto.allowedRouteIds === undefined ? undefined : { set: dto.allowedRouteIds.map((id) => ({ id })) },
      },
      include: PlansService.withRoutes,
    });

    if (plan.maxDownloadMbps !== before.maxDownloadMbps || plan.maxUploadMbps !== before.maxUploadMbps) {
      await this.reapplyRateLimits(plan);
    }

    // Editing which routes a plan may use has to reach the customers
    // already on it, or the change is only a promise about future
    // purchases. reapplyRateLimits exists for exactly this reason on the
    // speed caps; this is the same argument for the thing that decides
    // whether a credential should exist at all.
    //
    // Compared by content rather than trusting that the DTO mentioning
    // the field means it changed -- the panel form submits every field
    // on every save, so a name edit would otherwise reprovision the
    // whole plan.
    const routesChanged =
      dto.allowedRouteIds !== undefined &&
      !sameIds(
        before.allowedRoutes.map((r) => r.id),
        plan.allowedRoutes.map((r) => r.id),
      );
    if (routesChanged) {
      await this.reprovisionPlan(plan.id);
    }

    return plan;
  }

  /** Re-runs provisioning for every subscription on this plan.
   *
   * provisionAll reconciles in both directions, so this adds credentials
   * for routes the plan has gained and revokes ones for routes it has
   * lost. That second half is the point: without it, deselecting a route
   * would leave every existing customer still holding a working
   * credential for it, and the setting would describe nothing.
   *
   * One failing subscription must not stop the rest -- the same reason
   * routes.service.ts and the backfill both catch per subscription. A
   * relay-only plan with its relay down throws from provisionAll by
   * design, and that must not abort the sweep for everyone else.
   */
  private async reprovisionPlan(planId: string) {
    const subscriptions = await this.prisma.subscription.findMany({
      where: { planId },
      select: { id: true },
    });

    let failed = 0;
    for (const subscription of subscriptions) {
      try {
        await this.protocolUsers.provisionAll(subscription.id);
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `Reprovisioning subscription ${subscription.id} after a plan route change failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.logger.log(
      `Plan ${planId} route selection changed: reprovisioned ${subscriptions.length - failed} of ${
        subscriptions.length
      } subscription(s)`,
    );
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
