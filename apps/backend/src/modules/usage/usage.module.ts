import { forwardRef, Module } from "@nestjs/common";
import { UsageService } from "./usage.service";
import { ConcurrencyService } from "./concurrency.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { EmailModule } from "../email/email.module";
import { DeviceSlotsModule } from "../device-slots/device-slots.module";

@Module({
  // DeviceSlotsModule: which devices are carrying traffic, for the
  // device-limit backstop in ConcurrencyService.
  imports: [forwardRef(() => AgentGatewayModule), EmailModule, DeviceSlotsModule],
  providers: [UsageService, ConcurrencyService],
  exports: [UsageService, ConcurrencyService],
})
export class UsageModule {}
