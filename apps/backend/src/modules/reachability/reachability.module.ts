import { Module } from "@nestjs/common";
import { ReachabilityController } from "./reachability.controller";
import { ReachabilityService } from "./reachability.service";
import { CheckHostClient } from "./check-host.client";
import { PrismaModule } from "../../prisma/prisma.module";
import { EmailModule } from "../email/email.module";
import { AlertingModule } from "../alerting/alerting.module";

@Module({
  imports: [PrismaModule, EmailModule, AlertingModule],
  controllers: [ReachabilityController],
  providers: [ReachabilityService, CheckHostClient],
  // Exported for the scheduled job in modules/jobs, which owns the
  // cadence; this module owns what a cycle means.
  exports: [ReachabilityService],
})
export class ReachabilityModule {}
