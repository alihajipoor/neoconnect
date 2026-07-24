import { forwardRef, Module } from "@nestjs/common";
import { UsageService } from "./usage.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { EmailModule } from "../email/email.module";

@Module({
  imports: [forwardRef(() => AgentGatewayModule), EmailModule],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
