import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, readFileSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { AgentCommandType } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { NodesService } from "../nodes/nodes.service";
import { AgentConnectionRegistry } from "./agent-connection-registry";
import { resolveProtoPath } from "./proto-path";
import { verifyEd25519 } from "./ed25519";
import type { AgentDuplexCall, AgentMessageEnvelope, HelloMessage } from "./agent-messages";

// Hello timestamps must fall within this window of the server's clock --
// bounds replay of a captured Hello without requiring an interactive
// challenge round trip. Generous enough to tolerate real-world clock
// drift on cheap VPS boxes.
const HELLO_FRESHNESS_SECONDS = 120;

// A dead TCP connection is not reliably detected by grpc-js's stream
// 'error'/'end' events alone -- confirmed empirically: killing an agent
// process left its Node stuck at ONLINE for minutes with no error ever
// firing server-side (no NAT/firewall involved, just a plain killed
// process). Heartbeats (~20s apart, see agent/internal/controlplane)
// are the real liveness signal; this sweep is what actually acts on
// their absence, same "defensive re-scan" pattern as the quota/expiry
// sweeps in the architecture plan.
const HEARTBEAT_STALE_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

@Injectable()
export class AgentGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGatewayService.name);
  private server?: grpc.Server;
  private sweepHandle?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly nodesService: NodesService,
    private readonly registry: AgentConnectionRegistry,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    // Deliberately never throws out of here: this module starting is not
    // allowed to take down the rest of the app (panel/admin HTTP API) if
    // TLS certs aren't ready yet -- e.g. certbot failed on first install
    // because DNS wasn't pointed at the box yet. Worst case, agent
    // enrollment is unavailable until that's fixed and the container is
    // restarted; everything else keeps working.
    let credentials: grpc.ServerCredentials;
    let isSecure: boolean;
    try {
      ({ credentials, isSecure } = this.buildCredentials());
    } catch (err) {
      this.logger.error(
        `Agent gRPC gateway disabled: ${(err as Error).message}. Fix the underlying issue and restart the backend container.`,
      );
      return;
    }

    const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      neoxify: { agent: { v1: { AgentGateway: { service: grpc.ServiceDefinition } } } };
    };

    this.server = new grpc.Server();
    this.server.addService(proto.neoxify.agent.v1.AgentGateway.service, {
      agentSync: (call: AgentDuplexCall) => this.handleAgentSync(call),
    });

    const port = this.config.get<number>("agentGateway.grpcPort") ?? 50051;

    this.server.bindAsync(`0.0.0.0:${port}`, credentials, (err, boundPort) => {
      if (err) {
        this.logger.error(`Failed to bind agent gRPC gateway: ${err.message}`);
        return;
      }
      this.logger.log(
        `Agent gRPC gateway listening on port ${boundPort} (${isSecure ? "TLS" : "plaintext -- local dev only"})`,
      );
    });

    this.sweepHandle = setInterval(() => {
      this.sweepStaleNodes().catch((err) => {
        this.logger.warn(`Stale-node sweep failed: ${err}`);
      });
    }, SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
    this.server?.forceShutdown();
  }

  private async sweepStaleNodes() {
    const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);
    const stale = await this.prisma.node.findMany({
      where: { status: "ONLINE", lastHeartbeatAt: { lt: staleBefore } },
      select: { id: true, name: true },
    });
    for (const node of stale) {
      const call = this.registry.get(node.id);
      if (call) {
        call.destroy(new Error("heartbeat stale"));
        this.registry.delete(node.id, call);
      }
      await this.nodesService.setStatus(node.id, "OFFLINE");
      this.logger.warn(`Node ${node.id} (${node.name}) marked OFFLINE: no heartbeat for >${HEARTBEAT_STALE_MS}ms`);
    }
  }

  private buildCredentials(): { credentials: grpc.ServerCredentials; isSecure: boolean } {
    const certPath = this.config.get<string>("agentGateway.tlsCertPath");
    const keyPath = this.config.get<string>("agentGateway.tlsKeyPath");

    if (certPath && keyPath && existsSync(certPath) && existsSync(keyPath)) {
      const credentials = grpc.ServerCredentials.createSsl(null, [
        { cert_chain: readFileSync(certPath), private_key: readFileSync(keyPath) },
      ]);
      return { credentials, isSecure: true };
    }

    if (process.env.NODE_ENV === "production") {
      // Loud on purpose: an agent gateway that silently downgrades to
      // plaintext in production would ship every heartbeat and, later,
      // every provisioning command in the clear.
      this.logger.error(
        "AGENT_TLS_CERT_PATH/AGENT_TLS_KEY_PATH not set or unreadable in production -- refusing to start the agent gateway in plaintext.",
      );
      throw new Error("Agent gateway TLS certificate not configured in production");
    }

    return { credentials: grpc.ServerCredentials.createInsecure(), isSecure: false };
  }

  private handleAgentSync(call: AgentDuplexCall) {
    let nodeId: string | null = null;

    call.on("data", (msg: AgentMessageEnvelope) => {
      void (async () => {
        try {
          if (msg.payload === "hello") {
            nodeId = await this.handleHello(call, msg.hello!);
          } else if (msg.payload === "heartbeat") {
            if (!nodeId) {
              call.destroy(new Error("heartbeat received before a valid Hello"));
              return;
            }
            await this.nodesService.touchHeartbeat(nodeId);
          } else if (msg.payload === "commandAck") {
            await this.handleCommandAck(msg.commandAck!);
          }
          // statsBatch / stateSnapshot: no handling yet -- usage
          // accounting (M6) and full reconciliation are later work.
        } catch (err) {
          this.logger.warn(`AgentSync stream error: ${(err as Error).message}`);
          call.destroy(err as Error);
        }
      })();
    });

    const onClose = () => {
      if (nodeId) {
        this.registry.delete(nodeId, call);
        this.nodesService.setStatus(nodeId, "OFFLINE").catch((err) => {
          this.logger.warn(`Failed to mark node ${nodeId} offline: ${err}`);
        });
      }
    };
    call.on("end", () => {
      onClose();
      call.end();
    });
    call.on("error", onClose);
  }

  private async handleHello(call: AgentDuplexCall, hello: HelloMessage): Promise<string> {
    const node = await this.prisma.node.findUnique({ where: { id: hello.nodeId } });
    if (!node || !node.agentPubKey) {
      call.destroy(new Error(`unknown or unclaimed node: ${hello.nodeId}`));
      throw new Error("rejected");
    }

    const now = Math.floor(Date.now() / 1000);
    const ts = Number(hello.timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > HELLO_FRESHNESS_SECONDS) {
      call.destroy(new Error("Hello timestamp outside freshness window"));
      throw new Error("rejected");
    }

    const message = Buffer.from(`${hello.nodeId}.${hello.timestamp}.${hello.nonce}`, "utf8");
    const publicKey = Buffer.from(node.agentPubKey, "base64");
    const signature = Buffer.isBuffer(hello.signature) ? hello.signature : Buffer.from(hello.signature);

    if (!verifyEd25519(publicKey, message, signature)) {
      call.destroy(new Error("invalid Hello signature"));
      throw new Error("rejected");
    }

    await this.nodesService.setStatus(node.id, "ONLINE", { agentVersion: hello.agentVersion });
    this.registry.set(node.id, call);
    this.logger.log(`Node ${node.id} (${node.name}) authenticated and connected`);

    await this.replayQueuedCommands(node.id);
    return node.id;
  }

  private async handleCommandAck(ack: { commandId: string; success: boolean; error: string }) {
    await this.prisma.agentCommand.update({
      where: { id: ack.commandId },
      data: {
        status: ack.success ? "ACKED" : "FAILED",
        ackedAt: new Date(),
        error: ack.success ? null : ack.error,
      },
    });
  }

  /** Re-sends any command this node hasn't acked yet, in the order it was
   * created. Handles both "was never delivered" (agent was offline when
   * it was enqueued) and "delivered but the ack never arrived" (agent
   * crashed mid-command) the same way: commands are idempotent by
   * external_user_id on the agent side (create-if-not-exists,
   * delete-if-exists), so re-sending a command that already landed is
   * safe. */
  private async replayQueuedCommands(nodeId: string) {
    const pending = await this.prisma.agentCommand.findMany({
      where: { nodeId, status: { in: ["QUEUED", "SENT"] } },
      orderBy: { createdAt: "asc" },
    });
    for (const command of pending) {
      this.writeCommand(nodeId, command.id, command.type, command.payloadJson as object);
      await this.prisma.agentCommand.update({ where: { id: command.id }, data: { status: "SENT", sentAt: new Date() } });
    }
  }

  /** Writes a Command onto a node's live stream if it has one. Returns
   * whether it was actually sent -- false just means "queued, will go out
   * on next connect/reconnect via replayQueuedCommands", not an error. */
  private writeCommand(nodeId: string, commandId: string, type: AgentCommandType, payload: object): boolean {
    const call = this.registry.get(nodeId);
    if (!call) return false;
    call.write({
      command: {
        id: commandId,
        type,
        payloadJson: Buffer.from(JSON.stringify(payload), "utf8"),
      },
    });
    return true;
  }

  /** Public entry point for anything that needs to provision/change a
   * user on an agent (ProtocolUsersService today; quota enforcement in
   * M6 will call this too). Always durable -- writes the outbox row
   * first -- so a command issued while the node is offline isn't lost,
   * just delayed until reconnect. */
  async enqueueCommand(nodeId: string, type: AgentCommandType, payload: object) {
    const command = await this.prisma.agentCommand.create({
      data: { nodeId, type, payloadJson: payload, status: "QUEUED" },
    });

    const sent = this.writeCommand(nodeId, command.id, type, payload);
    if (sent) {
      await this.prisma.agentCommand.update({ where: { id: command.id }, data: { status: "SENT", sentAt: new Date() } });
    }
    return command;
  }
}
