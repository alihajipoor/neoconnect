import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { SubscriptionsService } from "./subscriptions.service";
import { CreateSubscriptionDto } from "./dto/create-subscription.dto";
import {
  AssignPlanDto,
  ChangePlanDto,
  ExtendSubscriptionDto,
  SetSubscriptionStatusDto,
} from "./dto/manage-subscription.dto";
import { AdminRole } from "@prisma/client";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";

@ApiTags("subscriptions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("subscriptions")
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get()
  list(@Query("customerId") customerId?: string) {
    // Filtered server-side rather than in the panel: a customer detail
    // page wants one customer's subscriptions, and fetching everyone's
    // to discard all but a few stops working the moment there are
    // enough customers to matter.
    if (customerId) return this.subscriptionsService.listByCustomer(customerId);
    return this.subscriptionsService.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.subscriptionsService.get(id);
  }

  /** Gives a customer a plan and provisions it, in one step.
   *
   * Distinct from POST / which only writes the row -- that is the
   * purchase flow's shape, where provisioning waits for payment. */
  @Post("assign")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN, AdminRole.BILLING)
  assign(@Body() dto: AssignPlanDto) {
    return this.subscriptionsService.assign(dto.customerId, dto.planId);
  }

  @Patch(":id/plan")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN, AdminRole.BILLING)
  changePlan(@Param("id") id: string, @Body() dto: ChangePlanDto) {
    return this.subscriptionsService.changePlan(id, dto.planId);
  }

  /** Suspend, resume, expire or cancel.
   *
   * Restricted beyond the usual admin guard: this decides whether
   * somebody who paid can use what they paid for, and it reaches the
   * nodes. SUPPORT can read the list; changing it is billing work. */
  @Patch(":id/status")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN, AdminRole.BILLING)
  setStatus(@Param("id") id: string, @Body() dto: SetSubscriptionStatusDto) {
    return this.subscriptionsService.setStatus(id, dto.status);
  }

  @Post(":id/extend")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN, AdminRole.BILLING)
  extend(@Param("id") id: string, @Body() dto: ExtendSubscriptionDto) {
    return this.subscriptionsService.extend(id, dto.days);
  }

  @Post(":id/reset-usage")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN, AdminRole.BILLING)
  resetUsage(@Param("id") id: string) {
    return this.subscriptionsService.resetUsage(id);
  }

  /** Deletes the subscription and the credentials it provisioned.
   * SUPERADMIN only -- it destroys billing history's counterpart and
   * cannot be undone. */
  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  remove(@Param("id") id: string) {
    return this.subscriptionsService.remove(id);
  }

  @Post()
  create(@Body() dto: CreateSubscriptionDto) {
    return this.subscriptionsService.create(dto);
  }
}
