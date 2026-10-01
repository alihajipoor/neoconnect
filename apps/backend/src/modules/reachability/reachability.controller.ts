import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { ReachabilityService } from "./reachability.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

@ApiTags("reachability")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("reachability")
export class ReachabilityController {
  constructor(private readonly reachability: ReachabilityService) {}

  /** Latest verdict per node. Readable by any admin: diagnosing why
   * customers cannot connect is support work, the same reasoning that
   * leaves /client-attempts unrestricted. */
  @Get()
  current() {
    return this.reachability.currentStatus();
  }

  @Get(":nodeId/history")
  history(@Param("nodeId") nodeId: string, @Query("limit") limit?: string) {
    return this.reachability.history(nodeId, limit ? Number(limit) : undefined);
  }

  /**
   * Probe now instead of waiting for the next scheduled cycle.
   *
   * SUPERADMIN-only, and not because the data is sensitive -- it is the
   * same data the GET returns. It calls out to a rate-limited third
   * party on behalf of the whole fleet, and a button any admin can hold
   * down is a button that gets the probe provider to start refusing us,
   * which blinds the monitoring for everyone.
   */
  @Post("run")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  run() {
    return this.reachability.runCycle();
  }
}
