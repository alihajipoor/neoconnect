import { forwardRef, Module } from "@nestjs/common";
import { AgentGatewayService } from "./agent-gateway.service";
import { AgentConnectionRegistry } from "./agent-connection-registry";
import { NodesModule } from "../nodes/nodes.module";
import { UsageModule } from "../usage/usage.module";
import { SiteVisitsModule } from "../site-visits/site-visits.module";

@Module({
  // SiteVisitsModule: the agents' DestinationBatch messages are stored
  // there. No cycle: it imports network identity and the admin audit only.
  imports: [NodesModule, forwardRef(() => UsageModule), SiteVisitsModule],
  providers: [AgentGatewayService, AgentConnectionRegistry],
  exports: [AgentConnectionRegistry, AgentGatewayService],
})
export class AgentGatewayModule {}
