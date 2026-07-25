import { Module } from "@nestjs/common";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";

@Module({
  // Deleting a customer has to tell their nodes to drop the credentials,
  // not just remove the rows -- same reason ProtocolUsersModule imports it.
  imports: [AgentGatewayModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
