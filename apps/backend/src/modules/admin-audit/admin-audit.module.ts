import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AdminAuditController } from "./admin-audit.controller";
import { AdminAuditInterceptor } from "./admin-audit.interceptor";
import { AdminAuditService } from "./admin-audit.service";

/** Every change an admin makes, logged (AdminAuditInterceptor, on every
 * route), and readable by the owner at GET /admin/audit.
 *
 * The service is exported for the few reads that are logged too, because
 * what they show is sensitive enough that looking is itself an action --
 * a customer's site history (modules/site-visits). */
@Module({
  controllers: [AdminAuditController],
  providers: [AdminAuditService, { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor }],
  exports: [AdminAuditService],
})
export class AdminAuditModule {}
