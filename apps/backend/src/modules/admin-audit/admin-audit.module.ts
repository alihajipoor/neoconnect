import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AdminAuditController } from "./admin-audit.controller";
import { AdminAuditInterceptor } from "./admin-audit.interceptor";
import { AdminAuditService } from "./admin-audit.service";

/** Every change an admin makes, logged (AdminAuditInterceptor, on every
 * route), and readable by the owner at GET /admin/audit. */
@Module({
  controllers: [AdminAuditController],
  providers: [AdminAuditService, { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor }],
})
export class AdminAuditModule {}
