import { Injectable } from "@nestjs/common";
import type { AgentDuplexCall } from "./agent-messages";

/** Tracks which agents currently have a live AgentSync stream open, so
 * commands generated elsewhere (subscription CRUD, quota enforcement) can
 * be pushed immediately instead of only landing on the agent's next
 * reconnect. Populated/cleared by AgentGatewayService; read by
 * AgentGatewayService.sendCommand, called from ProtocolUsersService etc. */
@Injectable()
export class AgentConnectionRegistry {
  private readonly connections = new Map<string, AgentDuplexCall>();

  set(nodeId: string, call: AgentDuplexCall) {
    this.connections.set(nodeId, call);
  }

  delete(nodeId: string, call: AgentDuplexCall) {
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

  /** Snapshot of the nodes with a live stream right now.
   *
   * A copy rather than the live key iterator, because callers iterate
   * asynchronously and a node connecting or dropping mid-sweep would
   * otherwise mutate the map while it is being walked.
   */
  connectedNodeIds(): string[] {
    return [...this.connections.keys()];
  }
}
