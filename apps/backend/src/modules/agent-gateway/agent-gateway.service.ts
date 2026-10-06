import { forwardRef, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, readFileSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { AgentCommandType, Prisma, Protocol } from "@prisma/client";
import { after, forEachBatch } from "../../common/batching";
import { PrismaService } from "../../prisma/prisma.service";
import { NodesService } from "../nodes/nodes.service";
import { UsageService } from "../usage/usage.service";
import { ConcurrencyService } from "../usage/concurrency.service";
import { decryptCredentials } from "../protocol-users/credentials-crypto";
import { liveCredentialWhere } from "../protocol-users/live-credentials";
import { rateLimitFor } from "../protocol-users/rate-limit";
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

// How often to re-assert provisioning on already-connected nodes. This
// is the recovery window for an engine restarting under a live agent --
// a customer is offline for at most this long before the node is put
// back the way it should be, without anyone noticing or intervening.
// Ten minutes trades a little recovery latency for not putting a burst
// of writes on every node every minute.
/** How often provisioned users are re-asserted onto connected nodes.
 *
 * Was ten minutes, which meant that after any `systemctl restart xray`
 * the node authenticated **nobody** for up to ten minutes: the inbounds
 * listen, the routes are restored within a minute, and every customer is
 * rejected with "invalid request user id" the whole time. Measured on
 * ir1 while changing its REALITY dest — the tunnel came back only once
 * this sweep ran.
 *
 * The ten minutes was chosen to bound cost, and that cost is smaller
 * than it looks: the sweep writes straight onto the stream
 * (`persist: false`), so it stores nothing. What it spends is one
 * CREATE_USER per active user per sweep. Measured 2026-08-15 with 270
 * active users across four nodes, 105 on the busiest — about four
 * messages a second fleet-wide at this interval, against an idempotent
 * create-if-not-exists on the agent.
 *
 * It does scale linearly with the customer base, so this is the number
 * to revisit if that grows by an order of magnitude — a node with
 * thousands of users would want the engine-restart signal instead of a
 * faster poll. That signal does not exist today: `Heartbeat` carries
 * cpu, memory and connection count and nothing about the engine, so
 * detecting a restart properly needs a proto change, an agent change and
 * an agent rollout. Polling is what is available without one. */
const REASSERT_INTERVAL_MS = 60_000;

/** How often relayed routes are re-asserted onto connected nodes.
 *
 * Separate from REASSERT_INTERVAL_MS, and far shorter, because this
 * interval is the width of the window in which a relay customer's
 * traffic egresses at the relay instead of at the exit. See the comment
 * at the sweep itself for why the two cannot share a schedule. */
const ROUTE_REASSERT_INTERVAL_MS = 60_000;

/** Command-id prefix for a route's uplink re-assert.
 *
 * Synthetic, like the other sweep prefixes -- there is no AgentCommand
 * row behind it -- but unlike them the ack carries information worth
 * keeping, so it encodes the route id and handleCommandAck writes the
 * outcome back onto the Route. Exported for the spec that proves the
 * restart-then-reassert cycle restores the uplink. */
export const UPLINK_ACK_PREFIX = "reassert-uplink:";

/** Command-id prefix for re-asserting a credential no node has confirmed
 * yet (ProtocolUser.provisionedAt is null). Its ack is what records the
 * confirmation; a confirmed credential is re-asserted under the plain
 * `reassert:` prefix, whose ack is ignored, so the confirmed majority
 * costs no database write per user per minute. */
export const CONFIRM_ACK_PREFIX = "reassert-confirm:";

/** Commands that switch a credential off on its node. */
const OFF_COMMANDS: ReadonlySet<AgentCommandType> = new Set<AgentCommandType>(["DELETE_USER", "DISABLE_USER"]);
/** And on. */
const ON_COMMANDS: ReadonlySet<AgentCommandType> = new Set<AgentCommandType>(["CREATE_USER", "ENABLE_USER", "UPDATE_USER"]);

/** How long before a re-assert's read a credential switched off still
 * counts as switched off "while the re-assert ran". Covers the gap in
 * every off path between sending the command and changing the row --
 * ProtocolUsersService.remove sends DELETE_USER and then deletes the
 * row, setEnabled sends DISABLE_USER and then updates it -- which is
 * milliseconds, and far shorter than any hold lease (HOLD_LEASE_MS), so
 * a hold that lapsed is never mistaken for one just placed. */
const OFF_RACE_MARGIN_MS = 30_000;

/** How long a periodic re-assert may go unacknowledged before the next
 * cycle writes it again regardless -- for an ack lost without the stream
 * closing. Until then the earlier one is still in the node's queue, and
 * a second copy would only lengthen it. */
const REASSERT_ACK_PATIENCE_MS = 10 * 60_000;

/** How long the last command per credential is remembered. Housekeeping:
 * only commands from the last OFF_RACE_MARGIN_MS, or sent while a batch
 * was being written, are ever consulted. */
const LAST_COMMAND_MEMORY_MS = 10 * 60_000;

interface LastUserCommand {
  /** Order among recorded commands; strictly increasing. */
  seq: number;
  at: number;
  off: boolean;
  type: AgentCommandType;
  payload: object;
}

@Injectable()
export class AgentGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGatewayService.name);
  private server?: grpc.Server;
  private sweepHandle?: NodeJS.Timeout;
  private reassertHandle?: NodeJS.Timeout;
  private routeReassertHandle?: NodeJS.Timeout;

  /** The last user command sent for each credential on each node -- what
   * keeps a re-assert from putting back a credential switched off while it
   * ran (see guardedReassert). In memory: the single-instance assumption
   * the rest of the backend makes, and it only has to outlive one batch. */
  private readonly lastUserCommand = new Map<string, LastUserCommand>();
  private userCommandSeq = 0;

  /** Re-asserts written straight onto a stream and not acknowledged yet,
   * by command id. The agent runs every command of every protocol in one
   * loop, so a re-assert still unacknowledged when the next cycle comes
   * round means the node is more than a cycle behind -- and an IKEv2
   * re-assert, which reloads every secret per user, is how it gets there.
   * See reassertProvisionedUsers. */
  private readonly unackedReasserts = new Map<string, { nodeId: string; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly nodesService: NodesService,
    private readonly registry: AgentConnectionRegistry,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => UsageService))
    private readonly usageService: UsageService,
    @Inject(forwardRef(() => ConcurrencyService))
    private readonly concurrencyService: ConcurrencyService,
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

    // Keepalive. Without it the server cannot tell a peer that has
    // stopped reading from one that is merely idle, and neither can the
    // agent: the socket stays ESTABLISHED, the stream never errors, and
    // both ends wait forever. germany-1 and singapore-1 sat exactly like
    // that for six days -- see docs/journal/log.md, 2026-08-30.
    //
    // min_ping_interval_without_data_ms must be no larger than the
    // agent's keepalive interval (30s, keepaliveTime in
    // agent/internal/controlplane/client.go) or the server answers the
    // agent's pings with GOAWAY/ENHANCE_YOUR_CALM and severs a healthy
    // connection -- a worse failure than the hang. Changing either side
    // means changing both.
    //
    // max_pings_without_data 0 means "unlimited": the agent dials with
    // PermitWithoutStream, so its pings legitimately arrive on an idle
    // connection, and the default of 2 would drop it for that alone.
    this.server = new grpc.Server({
      "grpc.keepalive_time_ms": 20_000,
      "grpc.keepalive_timeout_ms": 10_000,
      "grpc.keepalive_permit_without_calls": 1,
      "grpc.http2.min_ping_interval_without_data_ms": 20_000,
      "grpc.http2.max_pings_without_data": 0,
    });
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

    this.reassertHandle = setInterval(() => {
      this.reassertAllConnectedNodes().catch((err) => {
        this.logger.warn(`Provisioning re-assert sweep failed: ${err}`);
      });
    }, REASSERT_INTERVAL_MS);

    // Routes sweep separately from users. Both now run at 60s, so the
    // split is no longer about cadence -- it is so each half can be
    // reasoned about, and retimed, without dragging the other with it.
    // Users are the half that scales with the customer base; routes are a
    // dozen rows on the busiest relay we run.
    //
    // Why either needs to be fast, and they need it for different
    // reasons:
    //
    // A late USER re-assert is a plain outage. The inbounds listen, the
    // routes are ready, and every customer is rejected with "invalid
    // request user id" until the sweep runs. At the old ten minutes that
    // was a ten-minute outage after any `systemctl restart xray` --
    // measured on ir1 on 2026-08-15, where the tunnel came back only once
    // this sweep fired.
    //
    // A late ROUTE re-assert is worse than an outage, because nothing
    // stops. With no rule matching the entry inbound, traffic falls
    // through to the relay's own default outbound and leaves from the
    // relay itself, so a customer routing through Iran to get out of Iran
    // egresses in Iran while the app shows a healthy connection. ir1's
    // access log recorded exactly one such session, 2026-08-13 23:50:51,
    // on a real customer's credential.
    //
    // ir1 now also fails closed -- its first outbound is a blackhole, so
    // unmatched relay traffic is dropped rather than leaked. That makes
    // the route window an outage instead of an exposure, but only on
    // nodes configured that way, and only Xray-entry routes are covered
    // by the rule at all. The sweep is still what ends the window.
    //
    // Note a static catch-all *rule* cannot do the same job: the agent
    // adds route rules with ShouldAppend=true
    // (agent/internal/relay/provisioner.go), so any rule already in
    // config.json is evaluated FIRST and would blackhole every relay
    // route rather than only the unmatched ones. It has to be the default
    // outbound, which is a per-node config change.
    this.routeReassertHandle = setInterval(() => {
      this.reassertRoutesOnConnectedNodes().catch((err) => {
        this.logger.warn(`Route re-assert sweep failed: ${err}`);
      });
    }, ROUTE_REASSERT_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
    if (this.reassertHandle) clearInterval(this.reassertHandle);
    if (this.routeReassertHandle) clearInterval(this.routeReassertHandle);
    this.server?.forceShutdown();
  }

  /** Periodically re-asserts every connected node's users.
   *
   * The on-connect re-assert covers a node rebooting or its agent
   * restarting. It cannot cover an engine restarting underneath a live
   * agent -- `systemctl restart xray` leaves the control stream up, so
   * there is no reconnect to react to, and the users are gone anyway.
   *
   * The agent can't detect that either: after Xray restarts its API
   * answers normally and simply reports no users, which is
   * indistinguishable from an idle node unless the agent persists its own
   * copy of what should exist. The backend already knows that, so the
   * safety net lives here.
   *
   * Bounded cost: these are written straight onto the stream rather than
   * stored as commands. Persisting one row per user per sweep would be
   * thousands of rows a day on a busy node, all recording that nothing
   * changed. */
  private async reassertAllConnectedNodes() {
    this.forgetOldUserCommands();
    for (const nodeId of this.registry.connectedNodeIds()) {
      await this.reassertProvisionedUsers(nodeId, { persist: false });
      // Routes are deliberately NOT re-asserted here. They have their own
      // sweep on the same interval, and doing both from both timers would
      // send every CONFIGURE_ROUTE twice a minute for nothing. See
      // reassertRoutesOnConnectedNodes.
    }
  }

  /** Routes only.
   *
   * Deliberately does NOT re-assert users; the other sweep owns those.
   * Keeping the halves apart means the interval of the one that scales
   * with the customer base (users) can be changed without also slowing
   * the one that guards against traffic leaving from a relay. */
  private async reassertRoutesOnConnectedNodes() {
    for (const nodeId of this.registry.connectedNodeIds()) {
      await this.reassertConfiguredRoutes(nodeId, { persist: false });
    }
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
      // setStatus has just alerted on the transition; hold the repeat
      // reminder back one interval so both do not arrive at once.
      this.nodesService.suppressNextOfflineReminder(node.id);
      this.logger.warn(`Node ${node.id} (${node.name}) marked OFFLINE: no heartbeat for >${HEARTBEAT_STALE_MS}ms`);
    }

    // Nodes that were already OFFLINE produce no transition and so no
    // alert. Without this, a node that goes down and stays down is
    // reported exactly once and then never again -- which is how two of
    // six ran dark for six days. See docs/journal/log.md, 2026-08-30.
    await this.nodesService.remindAboutOfflineNodes();
  }

  /** A stream ending is not the same as the node being down.
   *
   * This used to mark the node OFFLINE the moment the stream closed. On a
   * link that drops and re-dials within a second that produced a full
   * outage alert per drop -- and, because this path never called
   * suppressNextOfflineReminder the way the sweep does, a "STILL OFFLINE
   * -- no heartbeat for 0h" immediately behind it. turkey-1 sits on such
   * a link and generated three alerts per blip, dozens of times a day,
   * without ever missing a heartbeat deadline.
   *
   * Liveness is now decided in one place, sweepStaleNodes, against
   * HEARTBEAT_STALE_MS. A node whose stream closes and does not come back
   * still goes OFFLINE within one sweep of that deadline, which is what
   * the threshold already promised -- so a real outage is still caught,
   * and a reconnect faster than the threshold is correctly silent.
   *
   * The registry entry goes immediately regardless: it is the routing
   * table, and a closed call must never be handed work.
   */
  private handleStreamClosed(nodeId: string, call: AgentDuplexCall) {
    this.registry.delete(nodeId, call);
    // What was in flight on that stream is gone with it; the reconnect's
    // own re-assert sends everything again.
    for (const [id, sent] of this.unackedReasserts) if (sent.nodeId === nodeId) this.unackedReasserts.delete(id);
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
            // Agents older than v0.2.8 send no dest at all, so this is a
            // no-op for them rather than a downgrade to "unreachable".
            const hb = msg.heartbeat;
            if (hb?.realityDest) {
              await this.nodesService.recordRealityDestHealth(
                nodeId,
                hb.realityDest,
                hb.realityDestReachable === true,
              );
            }
          } else if (msg.payload === "commandAck") {
            await this.handleCommandAck(msg.commandAck!);
          } else if (msg.payload === "statsBatch") {
            if (!nodeId) {
              call.destroy(new Error("statsBatch received before a valid Hello"));
              return;
            }
            await this.usageService.recordDeltas(nodeId, msg.statsBatch?.deltas ?? []);
            // The device limit rides along with usage: same poll. Which
            // devices are active comes from the usage deltas as much as
            // from the session counts (see ConcurrencyService), and an
            // engine that reports no counts is unknown rather than zero.
            // handleReport never throws, so a counting problem cannot
            // close this node's control stream.
            await this.concurrencyService.handleReport(nodeId, {
              sessions: msg.statsBatch?.sessions ?? [],
              deltas: msg.statsBatch?.deltas ?? [],
            });
          }
          // stateSnapshot: no handling yet -- full reconciliation is later work.
        } catch (err) {
          this.logger.warn(`AgentSync stream error: ${(err as Error).message}`);
          call.destroy(err as Error);
        }
      })();
    });

    const onClose = () => {
      if (nodeId) this.handleStreamClosed(nodeId, call);
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
    await this.reassertProvisionedUsers(node.id);
    await this.reassertConfiguredRoutes(node.id);
    return node.id;
  }

  /** Re-sends a CREATE_USER for every customer who should exist on this
   * node, whether or not one was ever sent before.
   *
   * This is separate from replayQueuedCommands, which only resends
   * commands that were never acked. After a reboot every past command is
   * ACKED, so that path replays nothing -- and yet the node has lost
   * every user, because no engine here keeps them:
   *
   * * Xray holds them in memory, added over its gRPC API; a restart
   *   empties the inbound.
   * * WireGuard peers are added with `wg set`, which mutates the running
   *   interface and never touches wg0.conf (see the note in
   *   agent/internal/protocols/wireguard).
   *
   * So an agent that reconnects is an agent whose engines may have just
   * come up empty, and the only safe assumption is that they did. Before
   * this, a node reboot silently cut off every customer on it,
   * permanently, with nothing in the panel indicating anything was
   * wrong -- confirmed live: restarting Xray left an ACTIVE, correctly
   * provisioned customer unable to authenticate.
   *
   * Safe to run when nothing was lost: CREATE_USER is idempotent on the
   * agent side (create-if-not-exists), the same property
   * replayQueuedCommands already relies on. */
  /** Re-sends CONFIGURE_ROUTE for every relayed route entering this node.
   *
   * The sibling of reassertProvisionedUsers, and needed for the same
   * reason: a relay's outbound and routing rule are hot-added over
   * Xray's gRPC API, so an Xray restart empties them exactly as it
   * empties the inbound's users. Re-asserting users alone left the node
   * with customers who authenticate and a router with nowhere to send
   * them.
   *
   * That failure is worse than an outage and is why this exists.
   * With no rule matching the entry inbound, traffic falls through to
   * the relay's own `direct` outbound and egresses *at the relay* --
   * measured on ir1, 2026-08-13, where a customer on the France route
   * came out at the Iran node's own address. The tunnel works, the app
   * reports a healthy connection, and the customer's traffic leaves from
   * the country they were trying to route around.
   *
   * Only enabled, relayed routes: a direct route installs no rule, so
   * there is nothing to restore.
   */
  private async reassertConfiguredRoutes(nodeId: string, opts: { persist: boolean } = { persist: true }) {
    const routes = await this.prisma.route.findMany({
      where: { isEnabled: true, exitProtocolConfigId: { not: null }, entryProtocolConfig: { nodeId } },
      include: {
        entryProtocolConfig: true,
        exitProtocolConfig: { include: { node: { select: { id: true, publicIp: true } } } },
      },
    });
    if (routes.length === 0) return;

    for (const route of routes) {
      if (!route.exitProtocolConfig || !route.uplinkCredentialsJson) continue;
      const entry = route.entryProtocolConfig;
      const exit = route.exitProtocolConfig;
      const entryIsXray = XRAY_SERVED_ON_NODE.has(entry.protocol);

      // The other half of the route, and the half that was missing.
      //
      // A relay route is two hot-added things on two different nodes: the
      // outbound and rule on the ENTRY (below), and the uplink credential
      // on the EXIT's inbound. Only the entry half was ever re-asserted.
      // The uplink was created exactly once, by RoutesService.create, and
      // has no ProtocolUser row -- so reassertProvisionedUsers, which
      // reads protocolUser, could never see it either. An Xray restart on
      // an exit node therefore deleted it permanently.
      //
      // That is not hypothetical. france-1 restarted Xray on 2026-08-19
      // and finland1 on 2026-08-20; on 2026-08-23 both exits held exactly
      // their direct customers and zero `route:` users, all thirteen
      // relay routes were dead, and the entry half had been faithfully
      // re-asserted the whole time -- ir1 held every outbound and rule,
      // pointed at a credential the exit no longer recognised. france-1's
      // own access log recorded the result: "rejected
      // proxy/vless/encoding: invalid request user id".
      //
      // Re-asserting it here rather than giving it a ProtocolUser row:
      // a ProtocolUser requires a subscriptionId, and the uplink belongs
      // to no subscription -- it is the relay's aggregate identity, which
      // is the whole point of it. Faking a subscription to make the user
      // sweep pick it up would put a synthetic customer into quota,
      // usage and concurrency accounting. The credential already lives on
      // the Route; this makes the sweep that owns routes assert all of it.
      await this.assertRouteUplink(route.id, exit, JSON.parse(route.uplinkCredentialsJson) as Record<string, string>);
      const payload = {
        routeId: route.id,
        entryInboundTag: entryIsXray ? defaultInboundTag(entry) : "",
        entrySubnetCidr: entryIsXray ? "" : subnetCidrOf(entry.publicParamsJson),
        exit: {
          address: exit.node.publicIp,
          port: exit.listenPort,
          protocol: exit.protocol,
          publicParams: exit.publicParamsJson,
          uplinkCredentials: JSON.parse(route.uplinkCredentialsJson) as Record<string, string>,
        },
      };
      if (opts.persist) {
        await this.enqueueCommand(nodeId, "CONFIGURE_ROUTE", payload);
      } else {
        this.writeCommand(nodeId, `reassert-route:${route.id}`, "CONFIGURE_ROUTE", payload);
      }
    }
    this.logger.log(`Re-asserted ${routes.length} relay route(s) on node ${nodeId}`);
  }

  /** Re-installs one route's shared uplink credential on its exit node.
   *
   * Sent to the EXIT node, which is a different node from the one the
   * surrounding sweep is walking -- and may not be connected at all, in
   * which case nothing is claimed. Silence here would be the same bug
   * this whole change exists to remove, so a route whose exit is
   * unreachable is recorded as not asserted rather than left showing
   * whatever it last said.
   *
   * `inboundTag` is passed for the same reason every other CREATE_USER
   * carries it: an exit that runs more than one inbound of a protocol
   * would otherwise take the uplink onto its default one, where the
   * relay does not dial. RoutesService.create omits it, which is a latent
   * bug on any multi-inbound exit; fixed there too.
   */
  private async assertRouteUplink(
    routeId: string,
    exit: { nodeId: string; protocol: string; transport: string | null; inboundTag: string | null },
    uplinkCredentials: Record<string, string>,
  ) {
    const payload = {
      protocol: exit.protocol,
      transport: exit.transport,
      ...(exit.inboundTag ? { inboundTag: exit.inboundTag } : {}),
      externalUserId: `route:${routeId}`,
      credentials: uplinkCredentials,
    };
    const sent = this.writeCommand(exit.nodeId, `${UPLINK_ACK_PREFIX}${routeId}`, "CREATE_USER", payload);
    if (!sent) {
      await this.recordUplinkResult(routeId, false, `exit node ${exit.nodeId} is not connected`);
    }
    // On success the ack decides, not the write: the write only proves the
    // bytes went onto a socket. handleCommandAck stamps uplinkAssertedAt
    // when the exit's agent confirms it.
  }

  /** Records what the exit node actually said about a route's uplink.
   *
   * This is the only thing standing between the panel and a green row
   * over a dead route, so it stores the failure text rather than logging
   * and dropping it. */
  private async recordUplinkResult(routeId: string, ok: boolean, error?: string) {
    await this.prisma.route.updateMany({
      where: { id: routeId },
      data: ok
        ? { uplinkAssertedAt: new Date(), uplinkLastError: null }
        : { uplinkLastError: (error ?? "unknown error").slice(0, 500) },
    });
  }

  /** Re-asserts every ACTIVE credential on one node.
   *
   * Cursored, and of the internal reads this is the one that most needed
   * it: it is the half of the re-assert pair that scales with the
   * customer base -- routes are a dozen rows, provisioned users are one
   * per customer per route -- and it runs every 60 s per connected node.
   * It is also not self-draining: a user is still ACTIVE after being
   * re-asserted, so a `take` here would have re-asserted the same first
   * page forever and left every customer past it dark on a node that had
   * just come back. */
  private async reassertProvisionedUsers(nodeId: string, opts: { persist: boolean } = { persist: true }) {
    let asserted = 0;
    let behind = 0;
    // When the batch being handled was read: a credential switched off
    // after that (or just before -- OFF_RACE_MARGIN_MS) is not put back.
    let readAt = Date.now();
    await forEachBatch({
      label: `reassertProvisionedUsers(${nodeId})`,
      read: (afterId, take) => {
        readAt = Date.now();
        return this.prisma.protocolUser.findMany({
          // Not every ACTIVE row: not a signed-out device's on its way off
          // the node -- see liveCredentialWhere.
          where: { nodeId, ...liveCredentialWhere(), ...after(afterId) },
      // For the transport and the inbound tag. Without either, every
      // re-assert after an engine restart rebuilds customers on the
      // wrong inbound -- silently, and for everyone at once, since
      // re-assert is exactly the path that runs when a node comes back.
      //
      // transport: WebSocket customers would be rebuilt on the TCP
      // inbound.
      //
      // inboundTag: worse. A relay runs one inbound per exit, so a
      // customer on the France listener would be rebuilt on the Finland
      // one -- or, if their credential is not on the inbound they dial
      // at all, rejected outright. Measured 2026-08-14: after an Xray
      // restart on ir1, all five France routes returned "invalid request
      // user id" while Finland kept working, because the re-assert had
      // put every France customer on the default inbounds.
      //
      // node and subscription: for the plan's speed caps, which go along
      // to agents that can take them (see reassertPayload).
          include: REASSERT_INCLUDE,
          orderBy: { id: "asc" },
          take,
        });
      },
      handle: async (users) => {
        for (const user of users) {
          const sent = await this.guardedReassert(user, readAt, (payload) => {
            if (opts.persist) return this.enqueueCommand(nodeId, "CREATE_USER", payload);
            // Last cycle's copy is still in the node's queue: it will be
            // carried out, and another would only lengthen the queue that
            // sign-outs and quota cuts wait in.
            if (this.stillQueued(user.id)) {
              behind += 1;
              return false;
            }
            this.writeReassert(user, payload);
            return true;
          });
          if (sent) asserted += 1;
        }
      },
    });

    if (behind > 0) {
      this.logger.warn(
        `Node ${nodeId} has not carried out ${behind} re-assert(s) from the last cycle: its command queue is more than ` +
          `${REASSERT_INTERVAL_MS / 1000} s behind, and sign-outs, quota cuts and new device credentials wait in it. ` +
          `Not sending those again until it catches up.`,
      );
    }
    if (asserted === 0) return;
    const how = opts.persist ? "after reconnect" : "on periodic re-assert";
    this.logger.log(`Re-asserted ${asserted} provisioned user(s) on node ${nodeId} ${how}`);
  }

  /** Whether a periodic re-assert of this credential was written within
   * REASSERT_ACK_PATIENCE_MS and has not been acknowledged. */
  private stillQueued(protocolUserId: string): boolean {
    const cutoff = Date.now() - REASSERT_ACK_PATIENCE_MS;
    return [`reassert:${protocolUserId}`, `${CONFIRM_ACK_PREFIX}${protocolUserId}`].some(
      (id) => (this.unackedReasserts.get(id)?.at ?? -Infinity) > cutoff,
    );
  }

  /** Puts these credentials back on their nodes now, rather than at the
   * next periodic re-assert up to a minute away -- for a device-limit hold
   * lifted because its device was let in (ConcurrencyService): that
   * device dials straight after its claim is granted. Live rows only, as
   * the periodic re-assert; a node not connected gets them on reconnect.
   * Never throws. */
  async reassertCredentials(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const readAt = Date.now();
      const users = await this.prisma.protocolUser.findMany({
        where: { id: { in: ids }, ...liveCredentialWhere() },
        include: REASSERT_INCLUDE,
      });
      for (const user of users) {
        // Put back on purpose: the hold's own DISABLE_USER, seconds ago,
        // is not a switch-off this must respect. One that lands from now
        // on still is.
        this.noteUserCommand(user.nodeId, "ENABLE_USER", { protocol: user.protocol, externalUserId: user.externalUserId });
        await this.guardedReassert(user, readAt, (payload) => this.writeReassert(user, payload));
      }
    } catch (err) {
      this.logger.warn(`Could not re-assert ${ids.length} credential(s) now: ${(err as Error).message}`);
    }
  }

  /** Re-asserts one credential read at `readAt`, unless it was switched
   * off since -- and switches it off again if that happens while the
   * CREATE_USER is being sent.
   *
   * A re-assert reads a batch of live rows and then sends CREATE_USER
   * for each; on reconnect it awaits a stored command per row, so the
   * window is the whole batch. A sign-out, an eviction, an account
   * deletion or a suspension landing in it sent its DELETE_USER or
   * DISABLE_USER and changed the row, and then the loop sent CREATE_USER
   * for the same credential: the node ran the delete and then the
   * create, and the credential stayed live there with no row behind it
   * -- for good, since nothing reconciles a node against the database.
   * Per-device sign-out makes such deletes routine. Returns whether the
   * CREATE_USER was sent. */
  private async guardedReassert(
    user: ReassertUser,
    readAt: number,
    send: (payload: object) => unknown,
  ): Promise<boolean> {
    const key = userCommandKey(user.nodeId, user.protocol, user.externalUserId);
    const before = this.lastUserCommand.get(key);
    if (before?.off && before.at >= readAt - OFF_RACE_MARGIN_MS) return false;

    const sentAfter = this.userCommandSeq;
    if ((await send(reassertPayload(user))) === false) return false;

    const after = this.lastUserCommand.get(key);
    if (after?.off && after.seq > sentAfter) {
      // Switched off while this was being sent: the node now has the off
      // and then this create. Send the off again, after it.
      await this.enqueueCommand(user.nodeId, after.type, after.payload).catch((err: unknown) =>
        this.logger.error(`Could not repeat ${after.type} for ${user.externalUserId} after a re-assert: ${String(err)}`),
      );
    }
    return true;
  }

  /** Remembers the last user command for a credential, before it is sent
   * (see guardedReassert). */
  private noteUserCommand(nodeId: string, type: AgentCommandType, payload: object) {
    const off = OFF_COMMANDS.has(type);
    if (!off && !ON_COMMANDS.has(type)) return;
    const { protocol, externalUserId } = payload as { protocol?: unknown; externalUserId?: unknown };
    if (typeof protocol !== "string" || typeof externalUserId !== "string") return;
    this.userCommandSeq += 1;
    this.lastUserCommand.set(userCommandKey(nodeId, protocol, externalUserId), {
      seq: this.userCommandSeq,
      at: Date.now(),
      off,
      type,
      payload,
    });
  }

  private forgetOldUserCommands() {
    const cutoff = Date.now() - LAST_COMMAND_MEMORY_MS;
    for (const [key, last] of this.lastUserCommand) if (last.at < cutoff) this.lastUserCommand.delete(key);
  }

  /** One re-assert, written straight onto the node's stream. Synthetic id:
   * the command has no AgentCommand row, so its ack is expected to match
   * nothing (see handleCommandAck). Prefixed so an unmatched ack is
   * recognisable rather than looking like data loss -- and, for a
   * credential no node has confirmed yet, so its ack can record the
   * confirmation. */
  private writeReassert(user: { id: string; nodeId: string; provisionedAt: Date | null }, payload: object) {
    const commandId = `${user.provisionedAt ? "reassert:" : CONFIRM_ACK_PREFIX}${user.id}`;
    if (this.writeCommand(user.nodeId, commandId, "CREATE_USER", payload)) {
      this.unackedReasserts.set(commandId, { nodeId: user.nodeId, at: Date.now() });
    }
  }

  /** Records a command's outcome.
   *
   * updateMany rather than update because periodic re-asserts are written
   * without a stored command (see reassertProvisionedUsers), so their acks
   * legitimately match nothing. `update` throws on a missing row, which
   * would turn every one of those acks into a stream error. */
  private async handleCommandAck(ack: { commandId: string; success: boolean; error: string }) {
    // A route's uplink is the one re-assert whose outcome is worth
    // storing rather than only logging: it is what decides whether the
    // route can carry anything, and nothing else on the route reports it.
    if (ack.commandId.startsWith(UPLINK_ACK_PREFIX)) {
      const routeId = ack.commandId.slice(UPLINK_ACK_PREFIX.length);
      if (!ack.success) {
        this.logger.error(`Route ${routeId} uplink re-assert REJECTED by its exit node: ${ack.error}`);
      }
      await this.recordUplinkResult(routeId, ack.success, ack.error);
      return;
    }

    // Every synthetic re-assert id, not just the user sweep's.
    //
    // This test was `startsWith("reassert:")`, which is the user sweep's
    // prefix alone -- so a failed route re-assert ("reassert-route:")
    // matched neither this branch nor an AgentCommand row and was
    // discarded in total silence. A relay whose outbound could not be
    // rebuilt looked exactly like one that had been rebuilt fine.
    if (ack.commandId.startsWith("reassert")) {
      this.unackedReasserts.delete(ack.commandId);
      if (!ack.success) {
        this.logger.warn(`Re-assert of ${ack.commandId} failed on the node: ${ack.error}`);
      } else if (ack.commandId.startsWith(CONFIRM_ACK_PREFIX)) {
        await this.markProvisioned({ id: ack.commandId.slice(CONFIRM_ACK_PREFIX.length) });
      }
      // Synthetic: there is no AgentCommand row to update, so nothing
      // more to do. (This used to run the updateMany below anyway, one
      // query per user per minute that could only ever match nothing.)
      return;
    }

    const command = await this.prisma.agentCommand.findUnique({
      where: { id: ack.commandId },
      select: { nodeId: true, type: true, payloadJson: true },
    });

    // A stored CREATE_USER or ENABLE_USER the node carried out means the
    // credential it names now exists there.
    const externalUserId = (command?.payloadJson as { externalUserId?: unknown } | null)?.externalUserId;
    if (
      ack.success &&
      command &&
      (command.type === "CREATE_USER" || command.type === "ENABLE_USER") &&
      typeof externalUserId === "string"
    ) {
      await this.markProvisioned({ nodeId: command.nodeId, externalUserId });
    }

    // The secret goes once nothing needs it. A CREATE_USER payload carries
    // the credential in the clear -- a WireGuard private key, an OpenVPN
    // key, an IKEv2 password -- while protocol_users holds it encrypted,
    // and agent_commands rows were only ever deleted with their node: any
    // database read or dump (the pre-deploy pg_dump among them) had every
    // credential ever provisioned. Replay reads QUEUED and SENT rows only,
    // so an acked or failed command never needs its credentials again.
    const stripped = withoutCredentials(command?.payloadJson);
    await this.prisma.agentCommand.updateMany({
      where: { id: ack.commandId },
      data: {
        status: ack.success ? "ACKED" : "FAILED",
        ackedAt: new Date(),
        error: ack.success ? null : ack.error,
        ...(stripped ? { payloadJson: stripped } : {}),
      },
    });
  }

  /** Records that a node has confirmed it holds a credential.
   *
   * What lets a device's own credential replace the shared one in what
   * the device is handed (ProtocolUsersService.deviceView): until a node
   * has acked it, the device keeps the shared credential that already
   * works. Only the first confirmation is written. */
  private async markProvisioned(where: { id: string } | { nodeId: string; externalUserId: string }) {
    await this.prisma.protocolUser.updateMany({
      where: { ...where, provisionedAt: null },
      data: { provisionedAt: new Date() },
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
    // Before anything else, so a re-assert that checks after writing its
    // own create always sees an off that was on its way.
    this.noteUserCommand(nodeId, type, payload);
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

function userCommandKey(nodeId: string, protocol: string, externalUserId: string): string {
  return `${nodeId}\u0000${protocol}\u0000${externalUserId}`;
}

/** What a re-assert reads with each credential. */
const REASSERT_INCLUDE = {
  protocolConfig: { select: { transport: true, inboundTag: true } },
  node: { select: { agentVersion: true } },
  subscription: { select: { plan: { select: { maxDownloadMbps: true, maxUploadMbps: true } } } },
} satisfies Prisma.ProtocolUserInclude;

type ReassertUser = {
  nodeId: string;
  protocol: string;
  externalUserId: string;
  credentialsJson: string;
  protocolConfig: { transport: string | null; inboundTag: string | null };
  node?: { agentVersion: string | null } | null;
  subscription?: { plan: { maxDownloadMbps: number | null; maxUploadMbps: number | null } | null } | null;
};

/** The first agent release that can be sent a plan's speed caps on every
 * re-assert: its applyRateLimit records a cap and applies only what
 * changed. Earlier agents rebuild a user's whole tc setup on every
 * CREATE_USER that carries caps -- a moment uncapped and a dozen tc
 * processes per capped WireGuard user, every 60 s -- so they are sent
 * none, as before.
 *
 * Caps used to arrive only at first provisioning and on a plan edit, and
 * the agent kept them in memory: after any agent restart (every rollout)
 * no OpenVPN customer who reconnected was shaped again, and after a
 * `wg-quick` restart or a reboot no WireGuard customer, until an admin
 * happened to edit the plan. Found by the 2026-10-06 review.
 *
 * If the agent release carrying that change is cut under another number,
 * this has to move with it. */
export const REASSERT_CAPS_FROM_AGENT = "0.2.10";

/** Whether an agent reporting this version takes caps on every re-assert.
 * Anything that is not a plain release number -- "dev", a missing
 * version -- is treated as too old. */
export function agentTakesReassertedCaps(agentVersion: string | null | undefined): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const have = agentVersion ? parse(agentVersion) : undefined;
  const need = parse(REASSERT_CAPS_FROM_AGENT)!;
  if (!have) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
}

/** The CREATE_USER a re-assert sends for one credential: its protocol,
 * transport and inbound, so it is rebuilt where it was created, and its
 * credentials decrypted, since the agent cannot use the stored form --
 * and the plan's speed caps, for an agent that can take them. */
function reassertPayload(user: ReassertUser) {
  return {
    protocol: user.protocol,
    transport: user.protocolConfig.transport,
    // Omitted entirely when null, so the payload stays byte-identical to
    // what every non-relay node already receives.
    ...(user.protocolConfig.inboundTag ? { inboundTag: user.protocolConfig.inboundTag } : {}),
    externalUserId: user.externalUserId,
    credentials: decryptCredentials(user.credentialsJson),
    // Nothing at all for an uncapped plan or an unshapeable protocol, the
    // same as at first provisioning (rateLimitFor).
    ...(agentTakesReassertedCaps(user.node?.agentVersion)
      ? rateLimitFor(user.subscription?.plan, user.protocol as Protocol)
      : {}),
  };
}

/** A stored payload with its `credentials` removed, or null when it had
 * none (nothing to rewrite). */
function withoutCredentials(payload: unknown): Prisma.InputJsonObject | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("credentials" in payload)) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
  const { credentials, ...rest } = payload as Record<string, unknown>;
  return rest as Prisma.InputJsonObject;
}

/** Which protocols this node serves from its Xray process. Not the same
 * as "starts with XRAY_" -- Shadowsocks is one of them. Mirrors
 * RoutesService; see the note there. */
const XRAY_SERVED_ON_NODE = new Set(["XRAY_VLESS_REALITY", "XRAY_VLESS_TLS", "XRAY_VMESS", "XRAY_TROJAN", "SHADOWSOCKS"]);

/** The inbound a route's rule should match: the config's own tag when it
 * has one, else the node default the installer templates write. Mirrors
 * entryInboundTag in RoutesService. */
function defaultInboundTag(config: { protocol: string; transport: string | null; inboundTag: string | null }): string {
  if (config.inboundTag) return config.inboundTag;
  switch (config.protocol) {
    case "XRAY_VLESS_REALITY":
      return "vless-in";
    case "XRAY_VLESS_TLS":
      return config.transport === "WS" ? "vless-ws-in" : "vless-tls-in";
    case "XRAY_TROJAN":
      return "trojan-in";
    case "SHADOWSOCKS":
      return "shadowsocks-in";
    default:
      return "";
  }
}

/** The client subnet a WireGuard/OpenVPN relay entry bridges into Xray.
 *
 * Narrowed rather than stringified: publicParamsJson is Json, so a
 * String() on it would turn a malformed value into "[object Object]" and
 * hand the agent a subnet it would try to route. Empty means absent, and
 * the agent rejects the command rather than guessing. */
function subnetCidrOf(publicParamsJson: unknown): string {
  const params = publicParamsJson as Record<string, unknown> | null;
  // Two names for one thing. WireGuard and OpenVPN configs call the
  // client subnet `subnetCidr`; IKEv2 calls it `pool`, because that is
  // strongSwan's own word for it and the config was written to match
  // the daemon rather than its siblings.
  //
  // Reading only the first name is what kept IKEv2 from ever being a
  // relay entry: this returned "" for it, and the agent then refused
  // the route with "missing entrySubnetCidr" -- a message that names a
  // field the IKEv2 config never had.
  const subnet = params?.subnetCidr ?? params?.pool;
  return typeof subnet === "string" ? subnet : "";
}
