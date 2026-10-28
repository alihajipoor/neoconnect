import { Controller, Get, Param, ParseUUIDPipe, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentAdmin } from "../../common/decorators/current-admin.decorator";
import type { AuthenticatedAdmin } from "../auth/types";
import { AdminAuditService } from "../admin-audit/admin-audit.service";
import { SiteVisitsService } from "./site-visits.service";

@ApiTags("customers")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("customers")
export class SiteVisitsController {
  constructor(
    private readonly siteVisits: SiteVisitsService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Where one customer's connections went, for up to seven days.
   *
   * The owner only, and every read is written to the admin audit log
   * with the customer's id in its path. Reads are otherwise never logged
   * (AdminAuditInterceptor logs changes only); this one is, because a
   * person's browsing is the most sensitive thing this backend holds
   * about them, and who looked at it, and when, should be on record. The
   * entry is written when the answer has gone out, with the status it
   * got, as the interceptor does for changes. */
  @Get(":id/sites")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  sites(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query("days") days?: string,
    @Query("q") q?: string,
    @Query("take") take?: string,
  ) {
    res.once("finish", () => {
      void this.audit.record({
        adminId: admin.sub,
        email: admin.email,
        role: admin.role,
        method: req.method,
        path: (req.originalUrl ?? req.url).split("?")[0],
        status: res.statusCode,
        ip: req.ip,
      });
    });
    return this.siteVisits.sites(id, { days, q, take });
  }
}
