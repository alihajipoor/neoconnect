import { forwardRef, Module } from "@nestjs/common";
import { UsageService } from "./usage.service";
import { ConcurrencyService } from "./concurrency.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { EmailModule } from "../email/email.module";

@Module({
  imports: [forwardRef(() => AgentGatewayModule), EmailModule],
  providers: [UsageService, ConcurrencyService],
  exports: [UsageService, ConcurrencyService],
})
export class UsageModule {}
