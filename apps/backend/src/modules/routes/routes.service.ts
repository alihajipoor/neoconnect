import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Protocol } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { generateCredentials } from "../protocol-users/generate-credentials";
import { CreateRouteDto } from "./dto/create-route.dto";

// Only Xray's REALITY variant has a real provisioner/credential
// generator today (see generate-credentials.ts) -- an exit leg on any
// other Xray sub-protocol would need work there first, not here.
const SUPPORTED_EXIT_PROTOCOL = "XRAY_VLESS_REALITY";

@Injectable()
export class RoutesService {
  private readonly logger = new Logger(RoutesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGatewayService,
    private readonly protocolUsersService: ProtocolUsersService,
  ) {}

  /** Gives every existing customer who is entitled to this route a
   * credential for it.
   *
   * Without this a route only ever reaches subscriptions created after
   * it existed, so the customers who have been here longest would have
   * the fewest protocols to fall back to -- exactly backwards, and
   * invisible until one of them got blocked. Best-effort per
   * subscription: one failure must not stop the rest, and provisionAll
   * is idempotent so a retry costs nothing.
   */
  private async backfillExistingSubscriptions(routeId: string) {
    const route = await this.prisma.route.findUnique({
      where: { id: routeId },
      include: { entryProtocolConfig: { select: { protocol: true } } },
    });
    if (!route?.isEnabled) return;

    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        status: { in: ["ACTIVE", "SUSPENDED"] },
        plan: { protocolsAllowed: { has: route.entryProtocolConfig.protocol } },
      },
      select: { id: true },
    });

    let added = 0;
    for (const subscription of subscriptions) {
      try {
        added += (await this.protocolUsersService.provisionAll(subscription.id)).length;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Could not backfill route ${routeId} onto subscription ${subscription.id}: ${reason}`);
      }
    }
    if (added) this.logger.log(`Backfilled route ${routeId} onto ${added} subscription(s)`);
  }

  list() {
    return this.prisma.route.findMany({ orderBy: { createdAt: "desc" } });
  }

  /** Customer-facing: which Routes a plan's customers may pick, i.e. the
   * location picker's option list. Reuses SubscriptionPlan.protocolsAllowed
   * (already in the schema, previously write-only/unenforced) rather than
   * adding a new plan<->route relation -- a route is eligible if it's
   * enabled and its entry protocol is one the plan allows.
   *
   * Deliberately an explicit `select`, not `include` -- a plain `include`
   * would return the raw Route row as-is, which contains
   * `uplinkCredentialsJson` (the relay's shared exit-node secret). That
   * must never reach a customer; only the fields a location picker
   * actually needs are selected here. */
  async listAvailableForPlan(protocolsAllowed: Protocol[]) {
    const routes = await this.prisma.route.findMany({
      where: {
        isEnabled: true,
        entryProtocolConfig: { protocol: { in: protocolsAllowed } },
      },
      select: {
        id: true,
        name: true,
        exitProtocolConfigId: true,
        entryProtocolConfig: {
          select: {
            protocol: true,
            // Without this the picker cannot tell one VLESS+TLS route
            // from another: the TCP and WebSocket variants share a
            // protocol, so both rendered as "Stealth HTTPS" and the list
            // showed two rows that looked identical and differed only in
            // latency.
            transport: true,
            listenPort: true,
            node: { select: { name: true, region: true, publicIp: true, status: true, lastHeartbeatAt: true } },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    return routes.map(({ exitProtocolConfigId, entryProtocolConfig, ...route }) => ({
      ...route,
      protocol: entryProtocolConfig.protocol,
      transport: entryProtocolConfig.transport,
      isRelay: exitProtocolConfigId !== null,
      location: { region: entryProtocolConfig.node.region, nodeName: entryProtocolConfig.node.name },
      // The address the client dials, so the app can measure its own
      // latency to each option rather than showing a number measured
      // from this server, which is irrelevant to the customer.
      //
      // Only the *entry* endpoint. A relayed route's exit node stays
      // hidden, per the same reasoning that keeps uplinkCredentialsJson
      // out of this response -- and the entry is what the client
      // connects to anyway, so it is also the honest thing to time.
      endpoint: { host: entryProtocolConfig.node.publicIp, port: entryProtocolConfig.listenPort },
      // Availability as the control plane sees it (agent heartbeats,
      // M2). Answers a different question from latency -- "is it up" vs
      // "is it fast for me" -- and a node that is down should be marked
      // so before the client wastes time probing it.
      nodeStatus: entryProtocolConfig.node.status,
    }));
  }

  async get(id: string) {
    const route = await this.prisma.route.findUnique({ where: { id } });
    if (!route) {
      throw new NotFoundException("Route not found");
    }
    return route;
  }

  async create(dto: CreateRouteDto) {
    const entryProtocolConfig = await this.prisma.protocolConfig.findUnique({
      where: { id: dto.entryProtocolConfigId },
      include: { node: true },
    });
    if (!entryProtocolConfig) throw new BadRequestException("Entry protocol config not found");

    if (!dto.exitProtocolConfigId) {
      const direct = await this.prisma.route.create({
        data: {
          name: dto.name,
          entryProtocolConfigId: dto.entryProtocolConfigId,
          isEnabled: dto.isEnabled ?? true,
        },
      });
      await this.backfillExistingSubscriptions(direct.id);
      return direct;
    }

    // Relayed route: entry must be on a RELAY node, exit must be the one
    // supported Xray variant on an EXIT node -- see "Multi-Hop Relay
    // Chaining" in the architecture plan for why the exit leg is always
    // Xray-based rather than any-protocol-to-any-protocol.
    if (entryProtocolConfig.node.role !== "RELAY") {
      throw new BadRequestException("A relayed route's entry protocol config must be on a RELAY-role node");
    }

    const exitProtocolConfig = await this.prisma.protocolConfig.findUnique({
      where: { id: dto.exitProtocolConfigId },
      include: { node: true },
    });
    if (!exitProtocolConfig) throw new BadRequestException("Exit protocol config not found");
    if (exitProtocolConfig.node.role !== "EXIT") {
      throw new BadRequestException("A relayed route's exit protocol config must be on an EXIT-role node");
    }
    if (exitProtocolConfig.protocol !== SUPPORTED_EXIT_PROTOCOL) {
      throw new BadRequestException(`Relayed routes' exit protocol config must be ${SUPPORTED_EXIT_PROTOCOL}`);
    }

    // One shared uplink credential for the whole route -- the exit node
    // never sees individual end customers, only the relay's aggregate
    // traffic. usedAddresses is irrelevant for Xray, passed empty.
    const { credentials: uplinkCredentials } = generateCredentials(exitProtocolConfig.protocol, exitProtocolConfig, []);

    const route = await this.prisma.route.create({
      data: {
        name: dto.name,
        entryProtocolConfigId: dto.entryProtocolConfigId,
        exitProtocolConfigId: dto.exitProtocolConfigId,
        uplinkCredentialsJson: JSON.stringify(uplinkCredentials),
        isEnabled: dto.isEnabled ?? true,
      },
    });

    await this.agentGateway.enqueueCommand(exitProtocolConfig.nodeId, "CREATE_USER", {
      protocol: exitProtocolConfig.protocol,
      // The relay's shared uplink is an ordinary user on the exit's
      // inbound, so it needs the same transport routing every other user
      // does -- an exit offered over WebSocket would otherwise get its
      // uplink built on the wrong listener.
      transport: exitProtocolConfig.transport,
      externalUserId: `route:${route.id}`,
      credentials: uplinkCredentials,
    });

    const entryIsXray = entryProtocolConfig.protocol.startsWith("XRAY_");
    await this.agentGateway.enqueueCommand(entryProtocolConfig.nodeId, "CONFIGURE_ROUTE", {
      routeId: route.id,
      entryInboundTag: entryIsXray ? entryInboundTag(entryProtocolConfig.protocol) : "",
      entrySubnetCidr: entryIsXray ? "" : entrySubnetCidr(entryProtocolConfig.publicParamsJson),
      exit: {
        address: exitProtocolConfig.node.publicIp,
        port: exitProtocolConfig.listenPort,
        protocol: exitProtocolConfig.protocol,
        publicParams: exitProtocolConfig.publicParamsJson,
        uplinkCredentials,
      },
    });

    await this.backfillExistingSubscriptions(route.id);
    return route;
  }

  async remove(id: string) {
    const route = await this.get(id);

    // Every subscription now holds a credential on every route it is
    // entitled to, so a route being deleted almost always has users on
    // it. The relation is required, so Prisma would refuse the delete --
    // and more importantly the accounts would be left running on the
    // engine with nothing in the database tracking them. remove() sends
    // DELETE_USER and drops the row.
    const users = await this.prisma.protocolUser.findMany({ where: { routeId: id }, select: { id: true } });
    for (const user of users) {
      await this.protocolUsersService.remove(user.id);
    }
    if (users.length) this.logger.log(`Removed ${users.length} protocol user(s) before deleting route ${id}`);

    if (route.exitProtocolConfigId) {
      const exitProtocolConfig = await this.prisma.protocolConfig.findUniqueOrThrow({
        where: { id: route.exitProtocolConfigId },
      });
      await this.agentGateway.enqueueCommand(exitProtocolConfig.nodeId, "DELETE_USER", {
        protocol: exitProtocolConfig.protocol,
        externalUserId: `route:${route.id}`,
      });

      const entryProtocolConfig = await this.prisma.protocolConfig.findUniqueOrThrow({
        where: { id: route.entryProtocolConfigId },
      });
      await this.agentGateway.enqueueCommand(entryProtocolConfig.nodeId, "REMOVE_ROUTE", { routeId: route.id });
    }

    await this.prisma.route.delete({ where: { id } });
  }
}

/** Xray inbounds are tagged `<protocol-lowercased-with-dashes>-in` by the
 * installer's config templates -- see installer/assets/xray-config.json.template
 * ("vless-in"). Only XRAY_VLESS_REALITY exists today. */
function entryInboundTag(protocol: string): string {
  if (protocol === "XRAY_VLESS_REALITY") return "vless-in";
  throw new BadRequestException(`No known inbound tag for entry protocol ${protocol}`);
}

function entrySubnetCidr(publicParamsJson: unknown): string {
  const params = publicParamsJson as Record<string, unknown> | null;
  const subnet = params?.subnetCidr;
  if (typeof subnet !== "string") {
    throw new BadRequestException("Entry protocol config's publicParamsJson is missing subnetCidr (required for WireGuard/OpenVPN relay entries)");
  }
  return subnet;
}
