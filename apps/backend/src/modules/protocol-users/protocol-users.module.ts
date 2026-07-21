import { Module } from "@nestjs/common";
import { ProtocolUsersController } from "./protocol-users.controller";
import { ProtocolUsersService } from "./protocol-users.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";

@Module({
  imports: [AgentGatewayModule],
  controllers: [ProtocolUsersController],
  providers: [ProtocolUsersService],
  exports: [ProtocolUsersService],
})
export class ProtocolUsersModule {}
