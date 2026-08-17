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

// Protocols the node serves from its Xray process, which is what decides
// whether a relayed route is wired by inbound tag or by client subnet.
// Not the same as "starts with XRAY_": Shadowsocks is one of these.
const XRAY_SERVED_PROTOCOLS = new Set([
  "XRAY_VLESS_REALITY",
  "XRAY_VLESS_TLS",
  "XRAY_VMESS",
  "XRAY_TROJAN",
  "SHADOWSOCKS",
]);

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
        added += (await this.protocolUsersService.provisionAll(subscription.id)).created.length;
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
   * location picker's option list.
   *
   * Eligibility is the plan's explicit route selection, intersected with
   * its protocols and with the route being enabled. It used to be
   * protocols alone -- that predates plans having a route relation at
   * all, and once they did, the picker kept offering servers the plan
   * was not served by. Customers on Starter and Pro saw the Iran relay
   * entries, tapped one, and got refused; from their side an app that
   * lists something and then says no is simply broken.
   *
   * Deliberately an explicit `select`, not `include` -- a plain `include`
   * would return the raw Route row as-is, which contains
   * `uplinkCredentialsJson` (the relay's shared exit-node secret). That
   * must never reach a customer; only the fields a location picker
   * actually needs are selected here. */
  async listAvailableForPlan(protocolsAllowed: Protocol[], allowedRouteIds: string[]) {
    const routes = await this.prisma.route.findMany({
      where: {
        isEnabled: true,
        // The plan's own selection, not just its protocols. Listing by
        // protocol alone showed every customer every route their
        // protocols could reach -- so Starter and Pro saw the Iran relay
        // entries, tapped one, and were refused by create(). To them
        // that reads as a broken app rather than a plan boundary, and
        // the honest fix is not to offer what cannot be chosen.
        //
        // Empty selection means the plan serves nothing, so the picker
        // shows nothing: `id: { in: [] }` matches no rows, which is the
        // correct answer rather than an edge case to special-case.
        id: { in: allowedRouteIds },
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

    // EXIT or STANDALONE, not EXIT alone.
    //
    // Relaxed 2026-08-13, when the Iran relay needed an exit and both
    // candidates were STANDALONE. A STANDALONE node already terminates
    // customer traffic and egresses to the internet -- that is precisely
    // what standalone means -- so it can carry a relay's uplink without
    // any change to how it works. The original EXIT-only rule assumed a
    // fleet large enough to dedicate machines to each job; on a
    // three-node fleet it would have forced buying a server to do a job
    // Finland already does, or flipping the role on nodes serving live
    // customers to satisfy a check rather than a requirement.
    //
    // RELAY is still excluded, and that one is a real constraint rather
    // than bookkeeping: pointing a relay's uplink at another relay
    // builds a chain that either loops or adds a hop nobody asked for,
    // and neither has an exit at the end of it.
    if (exitProtocolConfig.node.role === "RELAY") {
      throw new BadRequestException(
        "A relayed route's exit cannot be another RELAY node -- pick an EXIT or STANDALONE node",
      );
    }
    if (exitProtocolConfig.protocol !== SUPPORTED_EXIT_PROTOCOL) {
      throw new BadRequestException(`Relayed routes' exit protocol config must be ${SUPPORTED_EXIT_PROTOCOL}`);
    }

    // One exit per entry, because Xray cannot route two of them apart.
    //
    // CONFIGURE_ROUTE installs a routing rule whose only match condition
    // is the entry inbound's tag (see agent/internal/relay buildRoutingRule).
    // Two relayed routes on the same entry config therefore produce two
    // rules with identical match criteria, and Xray takes the first --
    // so the second route exists, provisions credentials, and appears in
    // the customer's location picker while its traffic leaves via the
    // first route's exit.
    //
    // Measured 2026-08-13 rather than reasoned: ir1 was given routes to
    // both finland1 and france-1, and a credential issued on the FRANCE
    // route exited at 204.168.161.100 -- finland1. A picker entry saying
    // France while the traffic leaves Finland is the same class of lie
    // as a false "Connected", so this refuses at creation instead.
    //
    // Lifting this needs the entry inbound tag to become a property of
    // the ProtocolConfig rather than of the protocol (it is a per-protocol
    // agent flag today), so one node can host several entry inbounds.
    const conflicting = await this.prisma.route.findFirst({
      where: {
        entryProtocolConfigId: dto.entryProtocolConfigId,
        exitProtocolConfigId: { not: null },
      },
      select: { id: true, name: true },
    });
    if (conflicting) {
      throw new BadRequestException(
        `Entry protocol config already relays via route "${conflicting.name}". A relay entry can serve only one exit: ` +
          `both routes would match the same Xray inbound and the second would silently use the first one's exit. ` +
          `Delete that route first, or add a separate entry protocol config for this exit.`,
      );
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

    // Shadowsocks is served by Xray too, despite the enum name not
    // saying so -- it is an inbound in the same process, with its own
    // tag. Keying off the "XRAY_" prefix sent it down the
    // WireGuard/OpenVPN branch, which demands a client subnet it has no
    // reason to have, so a Shadowsocks relay route could never be
    // created. Found on ir1, 2026-08-13.
    const entryIsXray = XRAY_SERVED_PROTOCOLS.has(entryProtocolConfig.protocol);
    await this.agentGateway.enqueueCommand(entryProtocolConfig.nodeId, "CONFIGURE_ROUTE", {
      routeId: route.id,
      entryInboundTag: entryIsXray ? entryInboundTag(entryProtocolConfig) : "",
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

/** Which Xray inbound on the relay this route's rule should match.
 *
 * The config's own `inboundTag` wins when it has one. That is what lets a
 * relay serve two exits: a second inbound of the same protocol, on its
 * own port with its own tag, gets its own routing rule instead of
 * colliding with the first one's.
 *
 * Otherwise the node's default tag for that protocol and transport,
 * which is what the installer's templates write -- see
 * installer/assets/xray-relay-config.json.template. Every Xray-family
 * protocol is listed, not just REALITY: with only REALITY here, a relay
 * offering the full protocol set could carry exactly one of them, and
 * the other four failed route creation with "No known inbound tag".
 * Measured on ir1, 2026-08-13, against a node the installer had just
 * configured with all five.
 *
 * Transport is part of the key for VLESS+TLS specifically, because its
 * TCP and WebSocket forms are deliberately two inbounds sharing one port
 * and one certificate -- the same reason the CREATE_USER payload has to
 * carry transport.
 */
function entryInboundTag(entryProtocolConfig: {
  protocol: string;
  transport?: string | null;
  inboundTag: string | null;
}): string {
  if (entryProtocolConfig.inboundTag) return entryProtocolConfig.inboundTag;

  const isWebSocket = entryProtocolConfig.transport === "WS";
  switch (entryProtocolConfig.protocol) {
    case "XRAY_VLESS_REALITY":
      return "vless-in";
    case "XRAY_VLESS_TLS":
      return isWebSocket ? "vless-ws-in" : "vless-tls-in";
    case "XRAY_TROJAN":
      return "trojan-in";
    case "SHADOWSOCKS":
      return "shadowsocks-in";
    default:
      throw new BadRequestException(
        `No known inbound tag for entry protocol ${entryProtocolConfig.protocol} -- set inboundTag on the protocol config`,
      );
  }
}

// Exported for its own spec. The rule it encodes -- which key a relay
// entry's client subnet lives under -- is worth pinning apart from
// create(), which needs an exit node, an uplink credential and a
// reachable agent before it reaches this line.
export function entrySubnetCidr(publicParamsJson: unknown): string {
  const params = publicParamsJson as Record<string, unknown> | null;
  // `pool` is IKEv2's name for the same field -- strongSwan's own term,
  // which its config was written against. Accepting both is what lets
  // IKEv2 be a relay entry at all; without it this threw about a
  // missing subnetCidr on a config that was never going to have one.
  const subnet = params?.subnetCidr ?? params?.pool;
  if (typeof subnet !== "string") {
    throw new BadRequestException(
      "Entry protocol config's publicParamsJson is missing subnetCidr (or pool, for IKEv2) -- required for non-Xray relay entries",
    );
  }
  return subnet;
}
