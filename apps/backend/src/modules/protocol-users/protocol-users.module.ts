import { Module } from "@nestjs/common";
import { ProtocolUsersController } from "./protocol-users.controller";
import { ProtocolUsersService } from "./protocol-users.service";
import { ProvisioningBackfillService } from "./provisioning-backfill.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { DeviceSlotsModule } from "../device-slots/device-slots.module";
import { RelayAuthModule } from "../relay-auth/relay-auth.module";

@Module({
  // DeviceSlotsModule: a device evicted by the device cap gives its plan
  // slot back too.
  imports: [AgentGatewayModule, DeviceSlotsModule, RelayAuthModule],
  controllers: [ProtocolUsersController],
  providers: [ProtocolUsersService, ProvisioningBackfillService],
  exports: [ProtocolUsersService],
})
export class ProtocolUsersModule {}
