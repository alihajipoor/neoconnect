import { Module } from "@nestjs/common";
import { AgentGatewayService } from "./agent-gateway.service";
import { AgentConnectionRegistry } from "./agent-connection-registry";
import { NodesModule } from "../nodes/nodes.module";

@Module({
  imports: [NodesModule],
  providers: [AgentGatewayService, AgentConnectionRegistry],
  exports: [AgentConnectionRegistry],
})
export class AgentGatewayModule {}
