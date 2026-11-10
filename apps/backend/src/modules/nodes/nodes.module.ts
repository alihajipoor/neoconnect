import { Module } from "@nestjs/common";
import { NodesController } from "./nodes.controller";
import { NodesService } from "./nodes.service";
import { EnrollmentModule } from "../enrollment/enrollment.module";
import { AlertingModule } from "../alerting/alerting.module";
import { NodeDoorsModule } from "../node-doors/node-doors.module";

@Module({
  imports: [EnrollmentModule, AlertingModule, NodeDoorsModule],
  controllers: [NodesController],
  providers: [NodesService],
  exports: [NodesService],
})
export class NodesModule {}
