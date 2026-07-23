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

export interface StatsBatchMessage {
  deltas: UsageDeltaMessage[];
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
