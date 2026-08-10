import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { decryptCredentials, encryptCredentials } from "./credentials-crypto";
import { CreateProtocolUserDto } from "./dto/create-protocol-user.dto";
import { rateLimitFor } from "./rate-limit";
import { generateCredentials } from "./generate-credentials";

@Injectable()
export class ProtocolUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGatewayService,
  ) {}

  async list(nodeId?: string) {
    const users = await this.prisma.protocolUser.findMany({
      where: nodeId ? { nodeId } : undefined,
      orderBy: { createdAt: "desc" },
    });
    return users.map(withDecryptedCredentials);
  }

  async get(id: string) {
    const user = await this.getRaw(id);
    return withDecryptedCredentials(user);
  }

  /** Customer-facing: only this customer's own credentials, resolved via
   * subscription ownership -- used by CustomerController, never exposed
   * via the admin-only routes above (which return everyone's).
   *
   * Also includes a `connection` field (server host/port + the entry
   * ProtocolConfig's publicParamsJson) alongside the per-user
   * `credentials` -- WireGuard/OpenVPN's generated credentials already
   * embed everything needed to connect (server pubkey/endpoint, or
   * cert/CA/endpoint), but Xray VLESS+REALITY's per-user credentials are
   * only `{uuid, flow}`; the REALITY server params (public key, shortId,
   * serverName, dest) live purely on the ProtocolConfig and were never
   * returned to a caller before. Uniform across all three protocols on
   * purpose, so a client doesn't need protocol-specific parsing just to
   * find the server address -- this is the field a native client needs
   * to actually build a working local tunnel config. */
  async listByCustomer(customerId: string) {
    const users = await this.prisma.protocolUser.findMany({
      where: { subscription: { customerId } },
      orderBy: { createdAt: "desc" },
      include: { node: true, protocolConfig: true },
    });
    return users.map(({ node, protocolConfig, ...user }) => ({
      ...withDecryptedCredentials(user),
      connection: connectionInfo(node, protocolConfig),
    }));
  }

  /** Internal callers (setEnabled, remove) need the raw encrypted row,
   * not the decrypted API-response shape get() returns. */
  private async getRaw(id: string) {
    const user = await this.prisma.protocolUser.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException("Protocol user not found");
    }
    return user;
  }

  async create(dto: CreateProtocolUserDto) {
    const [subscription, route] = await Promise.all([
      // The plan comes along for its bandwidth caps: the node needs them
      // at provisioning time, since a user created without a shaper would
      // run uncapped until something happened to re-provision them.
      this.prisma.subscription.findUnique({
        where: { id: dto.subscriptionId },
        include: { plan: true },
      }),
      this.prisma.route.findUnique({
        where: { id: dto.routeId },
        // The node comes along for the `connection` field below -- a
        // caller that just provisioned a user is exactly the caller
        // about to connect with it, so it must not have to make a second
        // request to find out where to connect.
        include: { entryProtocolConfig: { include: { node: true } } },
      }),
    ]);
    if (!subscription) throw new BadRequestException("Subscription not found");
    if (!route) throw new BadRequestException("Route not found");
    if (!route.isEnabled) throw new BadRequestException("Route is not enabled");

    const protocolConfig = route.entryProtocolConfig;

    const usedAddresses =
      protocolConfig.protocol === "WIREGUARD" ? await this.usedWireGuardAddresses(protocolConfig.id) : [];

    const { externalUserId, credentials } = generateCredentials(protocolConfig.protocol, protocolConfig, usedAddresses);

    const protocolUser = await this.prisma.protocolUser.create({
      data: {
        subscriptionId: dto.subscriptionId,
        routeId: dto.routeId,
        nodeId: protocolConfig.nodeId,
        protocolConfigId: protocolConfig.id,
        protocol: protocolConfig.protocol,
        externalUserId,
        credentialsJson: encryptCredentials(credentials),
      },
    });

    // Whether this route is direct or relayed is transparent here --
    // the customer is always provisioned on the entry engine only. A
    // relayed route's relay->exit tunnel was already wired once when the
    // Route itself was created (see routes.service.ts).
    await this.agentGateway.enqueueCommand(protocolConfig.nodeId, "CREATE_USER", {
      protocol: protocolConfig.protocol,
      externalUserId,
      credentials,
      ...rateLimitFor(subscription.plan, protocolConfig.protocol),
    });

    return {
      ...withDecryptedCredentials(protocolUser),
      connection: connectionInfo(protocolConfig.node, protocolConfig),
    };
  }

  /** Provisions this subscription on every route its plan allows.
   *
   * The client holds all of them at once so it can fail over to another
   * protocol without asking the server for anything. That is the whole
   * point: on a censored network the control plane is a plausible thing
   * to lose first, and a fallback that needs the network in order to
   * route around the network being broken is not a fallback.
   *
   * Idempotent, and has to be -- it runs on first payment, on every
   * renewal, when a plan changes, when a new route appears, and from the
   * backfill. Routes the subscription already has are skipped rather
   * than torn down and recreated, so re-running this never disturbs a
   * connected customer.
   */
  async provisionAll(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: true },
    });
    if (!subscription) throw new BadRequestException("Subscription not found");

    const [routes, existing] = await Promise.all([
      this.prisma.route.findMany({
        where: {
          isEnabled: true,
          entryProtocolConfig: { protocol: { in: subscription.plan.protocolsAllowed }, isEnabled: true },
        },
        select: { id: true },
        orderBy: { name: "asc" },
      }),
      this.prisma.protocolUser.findMany({ where: { subscriptionId }, select: { routeId: true } }),
    ]);

    const already = new Set(existing.map((u) => u.routeId));
    const created = [];
    for (const route of routes) {
      if (already.has(route.id)) continue;
      // Sequential, not Promise.all: WireGuard address allocation reads
      // the addresses already in use, so two routes on the same node
      // provisioned in parallel can pick the same one.
      created.push(await this.create({ subscriptionId, routeId: route.id }));
    }
    return created;
  }

  /** Customer-facing: the location picker's "switch server" action.
   *
   * Deliberately non-destructive. It used to remove every existing
   * ProtocolUser and create one for the chosen route, which under
   * provisionAll() would delete exactly the credentials failover depends
   * on -- and the shipped 0.1.0/0.2.0 clients both call this endpoint
   * when a customer picks a server, so the destructive version would
   * have broken apps already in the field.
   *
   * Switching is now a local choice the client makes between credentials
   * it already holds; this endpoint only guarantees the chosen one
   * exists and hands it back.
   */
  async switchRoute(subscriptionId: string, routeId: string) {
    const [subscription, route] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { plan: true } }),
      this.prisma.route.findUnique({ where: { id: routeId }, include: { entryProtocolConfig: true } }),
    ]);
    if (!subscription) throw new BadRequestException("Subscription not found");
    if (!route) throw new BadRequestException("Route not found");
    if (!route.isEnabled) throw new BadRequestException("Route is not enabled");
    if (!subscription.plan.protocolsAllowed.includes(route.entryProtocolConfig.protocol)) {
      throw new BadRequestException("This route's protocol is not allowed on your plan");
    }

    // Bring the rest up to date too, so a subscription created before a
    // route existed gains it the next time the customer touches the
    // picker rather than staying permanently short of options.
    await this.provisionAll(subscriptionId);

    const existing = await this.prisma.protocolUser.findFirst({
      where: { subscriptionId, routeId },
      include: { protocolConfig: { include: { node: true } } },
    });
    if (existing) {
      return {
        ...withDecryptedCredentials(existing),
        connection: connectionInfo(existing.protocolConfig.node, existing.protocolConfig),
      };
    }
    return this.create({ subscriptionId, routeId });
  }

  async remove(id: string) {
    const user = await this.getRaw(id);

    await this.agentGateway.enqueueCommand(user.nodeId, "DELETE_USER", {
      protocol: user.protocol,
      externalUserId: user.externalUserId,
    });

    await this.prisma.protocolUser.delete({ where: { id } });
  }

  async setEnabled(id: string, enabled: boolean) {
    const user = await this.getRaw(id);

    if (enabled) {
      // Re-enabling needs the original credentials back, not just a flag
      // flip -- see the SetEnabled contract in agent/internal/protocols/common.
      const credentials = decryptCredentials(user.credentialsJson);
      await this.agentGateway.enqueueCommand(user.nodeId, "ENABLE_USER", {
        protocol: user.protocol,
        externalUserId: user.externalUserId,
        credentials,
      });
    } else {
      await this.agentGateway.enqueueCommand(user.nodeId, "DISABLE_USER", {
        protocol: user.protocol,
        externalUserId: user.externalUserId,
      });
    }

    const updated = await this.prisma.protocolUser.update({
      where: { id },
      data: { status: enabled ? "ACTIVE" : "DISABLED" },
    });
    return withDecryptedCredentials(updated);
  }

  private async usedWireGuardAddresses(protocolConfigId: string): Promise<string[]> {
    const existing = await this.prisma.protocolUser.findMany({
      where: { protocolConfigId },
      select: { credentialsJson: true },
    });
    return existing
      .map((u) => decryptCredentials(u.credentialsJson).address)
      .filter((address): address is string => Boolean(address));
  }
}

/** credentialsJson is encrypted at rest (see credentials-crypto.ts) --
 * admin API responses still need to hand back the actual usable
 * credentials (that's the entire point of this endpoint existing: an
 * admin retrieves them to give to a customer), so every external-facing
 * read replaces the encrypted string with the decrypted object. Access
 * control is the existing admin JWT guard, unchanged. */
function withDecryptedCredentials<T extends { credentialsJson: string }>(
  user: T,
): Omit<T, "credentialsJson"> & { credentials: Record<string, string> } {
  const { credentialsJson, ...rest } = user;
  return { ...rest, credentials: decryptCredentials(credentialsJson) };
}

/** The server-side half of what a native client needs to build a working
 * tunnel: where to connect, plus the entry ProtocolConfig's public
 * parameters.
 *
 * Shared by every customer-facing path that hands back a ProtocolUser
 * (list, switch-route, trial grant) rather than living inline in one of
 * them. It used to be inline in listByCustomer only, which meant
 * switching servers returned a ProtocolUser with no `connection` -- the
 * app then had a credential set with no server address and failed at the
 * point of connecting, well away from the cause. Keeping one builder
 * means a new customer-facing endpoint can't quietly reintroduce that. */
/** The publicParamsJson keys a client legitimately needs, per protocol.
 *
 * A whitelist rather than a blocklist, and deliberately so: this object
 * is handed to every customer, and it is not in fact all public. OpenVPN
 * stores its CA private key and the server's own key there, because the
 * backend signs client certificates and needs them. Returning the whole
 * object let any customer download the CA and sign themselves unlimited
 * client certificates -- access that would outlive their subscription
 * and survive their account being deleted, since nothing about it is
 * checked again after issuance.
 *
 * Anything not named here never reaches a client, so a key added to a
 * ProtocolConfig later is private by default rather than exposed by
 * omission. */
const CLIENT_VISIBLE_PUBLIC_PARAMS: Record<string, readonly string[]> = {
  XRAY_VLESS_REALITY: ["realityPublicKey", "shortIds", "dest", "serverName"],
  // Trojan's certificate is a real one for a real domain, and the client
  // verifies it with no allowInsecure escape hatch. So the domain has to
  // reach the client: without it the client falls back to the node's IP
  // as SNI, the certificate does not match that, and every connection
  // fails at the TLS handshake. The password is the customer's and lives
  // in credentials; the domain is the server's and lives here.
  XRAY_TROJAN: ["serverName"],
  // Same reasoning as Trojan: an ordinary certificate is verified against
  // a name, so the name has to travel. There is deliberately nothing
  // REALITY-shaped here -- no borrowed key, no shortId -- because this
  // variant presents a certificate of its own.
  //
  // `path` is only set when this config is carried over a WebSocket, and
  // it is not a secret: it is sent in the clear in the HTTP upgrade, so a
  // censor watching the connection already has it. It travels because the
  // client cannot guess it, and a mismatched path is answered by the
  // fallback web page rather than by the tunnel -- which looks to the
  // customer exactly like a server that is up but broken.
  XRAY_VLESS_TLS: ["serverName", "path"],
  WIREGUARD: ["serverPublicKey", "endpoint", "subnetCidr", "dns"],
  // caCertPem is genuinely needed to verify the server, and already
  // travels in the per-user credentials. caKeyPem and serverKeyPem are
  // the secrets and are absent on purpose.
  OPENVPN: ["endpoint", "proto", "tlsCryptKey"],
};

function connectionInfo(
  node: { publicIp: string },
  protocolConfig: {
    protocol: string;
    listenPort: number;
    publicParamsJson: unknown;
    transport?: string;
    security?: string;
  },
) {
  const allowed = CLIENT_VISIBLE_PUBLIC_PARAMS[protocolConfig.protocol] ?? [];
  const source = (protocolConfig.publicParamsJson ?? {}) as Record<string, unknown>;
  const publicParams: Record<string, unknown> = {};
  for (const key of allowed) {
    if (source[key] !== undefined) {
      publicParams[key] = source[key];
    }
  }

  return {
    host: node.publicIp,
    port: protocolConfig.listenPort,
    // How to carry it, and what to wrap it in. Without these a client
    // holding a VLESS credential has no way to tell a plain TLS inbound
    // from a WebSocket one -- the Protocol member is the same for both,
    // deliberately, and guessing wrong fails the handshake.
    //
    // Defaulted rather than required so a client keeps working against a
    // node whose row predates these columns.
    transport: protocolConfig.transport ?? "TCP",
    security: protocolConfig.security ?? "NONE",
    publicParams,
  };
}
