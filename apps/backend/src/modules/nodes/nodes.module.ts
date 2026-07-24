import { Module } from "@nestjs/common";
import { NodesController } from "./nodes.controller";
import { NodesService } from "./nodes.service";
import { EnrollmentModule } from "../enrollment/enrollment.module";
import { AlertingModule } from "../alerting/alerting.module";

@Module({
  imports: [EnrollmentModule, AlertingModule],
  controllers: [NodesController],
  providers: [NodesService],
  exports: [NodesService],
})
export class NodesModule {}
