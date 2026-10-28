import type * as grpc from "@grpc/grpc-js";

export interface HelloMessage {
  nodeId: string;
  timestamp: string | number;
  nonce: string;
  signature: Buffer;
  agentVersion: string;
}

export interface CommandAckMessage {
  commandId: string;
  success: boolean;
  error: string;
}

// bytesUp/bytesDown arrive as strings, not numbers -- the proto loader is
// configured with `longs: String` (see agent-gateway.service.ts) since a
// uint64 doesn't fit safely in a JS number.
export interface UsageDeltaMessage {
  externalUserId: string;
  protocol: string;
  bytesUp: string;
  bytesDown: string;
}

/** How many distinct places one user is currently connected from.
 *
 * `distinctSources` is a uint32 in the proto, so unlike the byte counters
 * above it arrives as a plain number rather than a string. Only sent by
 * engines that can measure concurrency -- in practice just Xray. */
export interface SessionCountMessage {
  externalUserId: string;
  protocol: string;
  distinctSources: number;
  /** The addresses behind the count, most recently seen first, at most 8:
   * a bare canonical IP each, and how many seconds before the report the
   * node last saw it, on the node's own clock (0 for an engine that only
   * knows "connected now"). Read by SourceAddressesService to put the
   * customer's address on a report that arrived through the VPN; the
   * device limit goes on counting `distinctSources`.
   *
   * Optional, and that is load-bearing: no agent before this field sends
   * it, and they must go on working. */
  sources?: SourceAddressMessage[];
}

export interface SourceAddressMessage {
  address: string;
  secondsAgo: number;
}

export interface StatsBatchMessage {
  deltas: UsageDeltaMessage[];
  sessions?: SessionCountMessage[];
}

/** What a node reports about its own REALITY camouflage destination.
 *
 * Optional throughout, and that is load-bearing: proto3 omits an unset
 * string, and every agent before v0.2.8 sends no dest at all. An absent
 * `realityDest` is "did not measure", never "unreachable" -- see the
 * comment on Heartbeat in packages/proto/agent.proto. */
export interface HeartbeatMessage {
  cpuPercent?: number;
  memPercent?: number;
  activeConnections?: number;
  realityDest?: string;
  realityDestReachable?: boolean;
}

export interface AgentMessageEnvelope {
  payload: "hello" | "heartbeat" | "statsBatch" | "commandAck" | "stateSnapshot";
  hello?: HelloMessage;
  heartbeat?: HeartbeatMessage;
  commandAck?: CommandAckMessage;
  statsBatch?: StatsBatchMessage;
}

export interface ControlMessageEnvelope {
  command?: {
    id: string;
    type: string;
    payloadJson: Buffer;
  };
}

export type AgentDuplexCall = grpc.ServerDuplexStream<AgentMessageEnvelope, ControlMessageEnvelope>;
