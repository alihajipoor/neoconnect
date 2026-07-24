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
      this.prisma.route.findUnique({ where: { id: dto.routeId }, include: { entryProtocolConfig: true } }),
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

    return withDecryptedCredentials(protocolUser);
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
