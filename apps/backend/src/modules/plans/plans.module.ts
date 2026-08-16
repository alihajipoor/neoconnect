import { forwardRef, Module } from "@nestjs/common";
import { PlansController } from "./plans.controller";
import { PlansService } from "./plans.service";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";

@Module({
  // Editing a plan's speed caps pushes UPDATE_USER to every existing
  // customer on it, so plans needs the agent gateway.
  //
  // And editing which routes a plan may use has to reconcile everyone
  // already on it -- adding credentials for routes gained, revoking
  // those for routes lost -- which is provisionAll's job, so plans needs
  // protocol-users too. forwardRef for the same reason as above: these
  // modules reference each other through the graph and Nest cannot
  // resolve the cycle without it.
  imports: [forwardRef(() => AgentGatewayModule), forwardRef(() => ProtocolUsersModule)],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
