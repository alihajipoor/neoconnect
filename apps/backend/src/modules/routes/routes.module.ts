import { Module } from "@nestjs/common";
import { RoutesController } from "./routes.controller";
import { RoutesService } from "./routes.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";

@Module({
  imports: [AgentGatewayModule],
  controllers: [RoutesController],
  providers: [RoutesService],
  exports: [RoutesService],
})
export class RoutesModule {}
