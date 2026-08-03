import { Module } from "@nestjs/common";
import { RoutesController } from "./routes.controller";
import { RoutesService } from "./routes.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";

@Module({
  imports: [AgentGatewayModule, ProtocolUsersModule],
  controllers: [RoutesController],
  providers: [RoutesService],
  exports: [RoutesService],
})
export class RoutesModule {}
