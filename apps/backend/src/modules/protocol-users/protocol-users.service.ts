import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { decryptCredentials, encryptCredentials } from "./credentials-crypto";
import { CreateProtocolUserDto } from "./dto/create-protocol-user.dto";
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
      this.prisma.subscription.findUnique({ where: { id: dto.subscriptionId } }),
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
    });

    return {
      ...withDecryptedCredentials(protocolUser),
      connection: connectionInfo(protocolConfig.node, protocolConfig),
    };
  }

  /** Customer-facing: moves a subscription's VPN account from whichever
   * route(s) it's currently on to a different one -- the location
   * picker's "switch server" action. Reuses remove()+create() directly
   * (DELETE_USER on the old node, CREATE_USER on the new one) rather than
   * inventing a dedicated agent command; there's no schema-level
   * guarantee of exactly one ProtocolUser per subscription (see
   * renewSubscription's own "existingUsers" list handling in
   * billing.service.ts), so this removes every existing one, not just
   * the first found. */
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

    const existing = await this.prisma.protocolUser.findMany({ where: { subscriptionId } });
    for (const user of existing) {
      await this.remove(user.id);
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
function connectionInfo(node: { publicIp: string }, protocolConfig: { listenPort: number; publicParamsJson: unknown }) {
  return {
    host: node.publicIp,
    port: protocolConfig.listenPort,
    publicParams: protocolConfig.publicParamsJson,
  };
}
