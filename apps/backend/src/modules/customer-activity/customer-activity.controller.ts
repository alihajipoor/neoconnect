import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import type { Response } from "express";
import { sendPage } from "../../common/pagination";
import { CustomerInsightService, type AttemptQuery } from "./customer-insight.service";
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
  constructor(
    private readonly activity: CustomerActivityService,
    private readonly insights: CustomerInsightService,
  ) {}

  /** Connected now, devices, the apps' connect reports and traffic per
   * day. The same staff as GET /customers/:id: no @Roles, so every staff
   * role and no reseller (JwtAuthGuard's default). */
  @Get(":id/activity")
  get(@Param("id", new ParseUUIDPipe()) id: string, @Query("attemptsTake") attemptsTake?: string) {
    return this.activity.activity(id, { attemptsTake });
  }

  /** The apps' reports over `days` (1-60, default 7), counted and read:
   * networks, routes, failure causes, credentials, codes, findings. The
   * same staff as /activity. */
  @Get(":id/insight")
  insight(@Param("id", new ParseUUIDPipe()) id: string, @Query("days") days?: string) {
    return this.insights.insight(id, { days });
  }

  /** Every report, filterable and paged; X-Total-Count carries the total. */
  @Get(":id/attempts")
  async attempts(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: AttemptQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendPage(res, await this.insights.attempts(id, query));
  }

  /** What the servers counted, per hour and as sessions over `hours`
   * (1-336, default 72), and per day for 30 days. */
  @Get(":id/usage")
  usage(@Param("id", new ParseUUIDPipe()) id: string, @Query("hours") hours?: string) {
    return this.insights.usage(id, { hours });
  }

  /** The account's events, newest first, paged. Staff actions from the
   * admin audit appear only for a SUPERADMIN, as the audit itself. */
  @Get(":id/history")
  async history(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Res({ passthrough: true }) res: Response,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    return sendPage(res, await this.insights.history(id, { take, skip }, admin));
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
