import { forwardRef, Module } from "@nestjs/common";
import { UsageService } from "./usage.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";

@Module({
  imports: [forwardRef(() => AgentGatewayModule)],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
