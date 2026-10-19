import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { Roles } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { AdminAuditService } from "./admin-audit.service";

/** The admin action log, for the owner. */
@ApiExcludeController()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("admin/audit")
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  @Roles(AdminRole.SUPERADMIN)
  list(@Query("limit") limit?: string, @Query("before") before?: string) {
    return this.audit.list(limit ? Number(limit) : 100, before ? new Date(before) : undefined);
  }
}
