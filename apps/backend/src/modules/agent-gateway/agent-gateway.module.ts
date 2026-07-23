import { forwardRef, Module } from "@nestjs/common";
import { AgentGatewayService } from "./agent-gateway.service";
import { AgentConnectionRegistry } from "./agent-connection-registry";
import { NodesModule } from "../nodes/nodes.module";
import { UsageModule } from "../usage/usage.module";

@Module({
  imports: [NodesModule, forwardRef(() => UsageModule)],
  providers: [AgentGatewayService, AgentConnectionRegistry],
  exports: [AgentConnectionRegistry, AgentGatewayService],
})
export class AgentGatewayModule {}
