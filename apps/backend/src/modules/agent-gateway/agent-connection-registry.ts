import { Injectable } from "@nestjs/common";
import type * as grpc from "@grpc/grpc-js";

/** Tracks which agents currently have a live AgentSync stream open, so
 * commands generated elsewhere (subscription CRUD, quota enforcement) can
 * be pushed immediately instead of only landing on the agent's next
 * reconnect. Populated/cleared by AgentGatewayService; read by whatever
 * enqueues AgentCommand rows once that exists (M3+). */
@Injectable()
export class AgentConnectionRegistry {
  private readonly connections = new Map<string, grpc.ServerDuplexStream<unknown, unknown>>();

  set(nodeId: string, call: grpc.ServerDuplexStream<unknown, unknown>) {
    this.connections.set(nodeId, call);
  }

  delete(nodeId: string, call: grpc.ServerDuplexStream<unknown, unknown>) {
    // Only clear if this is still the current connection for that node --
    // a reconnect may have already replaced it with a newer call.
    if (this.connections.get(nodeId) === call) {
      this.connections.delete(nodeId);
    }
  }

  isConnected(nodeId: string): boolean {
    return this.connections.has(nodeId);
  }

  get(nodeId: string) {
    return this.connections.get(nodeId);
  }
}
