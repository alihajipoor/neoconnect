import { forwardRef, Module } from "@nestjs/common";
import { PlansController } from "./plans.controller";
import { PlansService } from "./plans.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";

@Module({
  // Editing a plan's speed caps pushes UPDATE_USER to every existing
  // customer on it, so plans needs the agent gateway.
  imports: [forwardRef(() => AgentGatewayModule)],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
