import { Module } from "@nestjs/common";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";
import { DeviceSlotsModule } from "../device-slots/device-slots.module";

@Module({
  // Deleting a customer has to tell their nodes to drop the credentials,
  // not just remove the rows -- same reason ProtocolUsersModule imports it.
  // ProtocolUsersModule: an admin setting a password ends the customer's
  // device sessions, VPN credentials included.
  // DeviceSlotsModule: deleting an account frees its device slots.
  imports: [AgentGatewayModule, ProtocolUsersModule, DeviceSlotsModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
