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

export interface AgentMessageEnvelope {
  payload: "hello" | "heartbeat" | "statsBatch" | "commandAck" | "stateSnapshot";
  hello?: HelloMessage;
  commandAck?: CommandAckMessage;
}

export interface ControlMessageEnvelope {
  command?: {
    id: string;
    type: string;
    payloadJson: Buffer;
  };
}

export type AgentDuplexCall = grpc.ServerDuplexStream<AgentMessageEnvelope, ControlMessageEnvelope>;
