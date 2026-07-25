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
}

export interface StatsBatchMessage {
  deltas: UsageDeltaMessage[];
  sessions?: SessionCountMessage[];
}

export interface AgentMessageEnvelope {
  payload: "hello" | "heartbeat" | "statsBatch" | "commandAck" | "stateSnapshot";
  hello?: HelloMessage;
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
