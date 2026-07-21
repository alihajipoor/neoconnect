import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { CreateProtocolUserDto } from "./dto/create-protocol-user.dto";
import { generateCredentials } from "./generate-credentials";

@Injectable()
export class ProtocolUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGatewayService,
  ) {}

  list(nodeId?: string) {
    return this.prisma.protocolUser.findMany({
      where: nodeId ? { nodeId } : undefined,
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string) {
    const user = await this.prisma.protocolUser.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException("Protocol user not found");
    }
    return user;
  }

  async create(dto: CreateProtocolUserDto) {
    const [subscription, protocolConfig] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { id: dto.subscriptionId } }),
      this.prisma.protocolConfig.findUnique({ where: { id: dto.protocolConfigId } }),
    ]);
    if (!subscription) throw new BadRequestException("Subscription not found");
    if (!protocolConfig) throw new BadRequestException("Protocol config not found");
    if (protocolConfig.nodeId !== dto.nodeId) {
      throw new BadRequestException("Protocol config does not belong to the given node");
    }

    const usedAddresses =
      protocolConfig.protocol === "WIREGUARD" ? await this.usedWireGuardAddresses(dto.protocolConfigId) : [];

    const { externalUserId, credentials } = generateCredentials(protocolConfig.protocol, protocolConfig, usedAddresses);

    const protocolUser = await this.prisma.protocolUser.create({
      data: {
        subscriptionId: dto.subscriptionId,
        nodeId: dto.nodeId,
        protocolConfigId: dto.protocolConfigId,
        protocol: protocolConfig.protocol,
        externalUserId,
        credentialsJson: JSON.stringify(credentials),
      },
    });

    await this.agentGateway.enqueueCommand(dto.nodeId, "CREATE_USER", {
      protocol: protocolConfig.protocol,
      externalUserId,
      credentials,
    });

    return protocolUser;
  }

  async remove(id: string) {
    const user = await this.get(id);

    await this.agentGateway.enqueueCommand(user.nodeId, "DELETE_USER", {
      protocol: user.protocol,
      externalUserId: user.externalUserId,
    });

    await this.prisma.protocolUser.delete({ where: { id } });
  }

  async setEnabled(id: string, enabled: boolean) {
    const user = await this.get(id);

    if (enabled) {
      // Re-enabling needs the original credentials back, not just a flag
      // flip -- see the SetEnabled contract in agent/internal/protocols/common.
      const credentials = JSON.parse(user.credentialsJson) as Record<string, string>;
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

    return this.prisma.protocolUser.update({
      where: { id },
      data: { status: enabled ? "ACTIVE" : "DISABLED" },
    });
  }

  private async usedWireGuardAddresses(protocolConfigId: string): Promise<string[]> {
    const existing = await this.prisma.protocolUser.findMany({
      where: { protocolConfigId },
      select: { credentialsJson: true },
    });
    return existing
      .map((u) => (JSON.parse(u.credentialsJson) as Record<string, string>).address)
      .filter((address): address is string => Boolean(address));
  }
}
