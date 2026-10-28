import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentAdmin } from "../../common/decorators/current-admin.decorator";
import type { AuthenticatedAdmin } from "../auth/types";
import { CustomerActivityService } from "./customer-activity.service";

/** A customer's connections, on their profile page in the panel. */
@ApiTags("customers")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("customers")
export class CustomerActivityController {
  constructor(private readonly activity: CustomerActivityService) {}

  /** Connected now, devices, the apps' connect reports and traffic per
   * day. The same staff as GET /customers/:id: no @Roles, so every staff
   * role and no reseller (JwtAuthGuard's default). */
  @Get(":id/activity")
  get(@Param("id", new ParseUUIDPipe()) id: string, @Query("attemptsTake") attemptsTake?: string) {
    return this.activity.activity(id, { attemptsTake });
  }

  /** Signs one device out, as the device itself would. Support may, as
   * it is the usual answer to "I lost my phone"; billing has no reason to.
   * Recorded in the admin audit like every change. */
  @Post(":id/sessions/:sessionId/sign-out")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN, AdminRole.SUPPORT)
  @HttpCode(HttpStatus.OK)
  signOut(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.activity.signOutSession(id, sessionId, admin.email);
  }
}

/** Who is using the VPN right now, by the traffic the servers counted. */
@ApiTags("monitor")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("monitor")
export class MonitorController {
  constructor(private readonly activity: CustomerActivityService) {}

  /** Every customer with traffic in the last ten minutes. Any staff role,
   * as the customer list. */
  @Get("live")
  live() {
    return this.activity.live();
  }
}
