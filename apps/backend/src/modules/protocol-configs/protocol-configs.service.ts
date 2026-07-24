import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateProtocolConfigDto } from "./dto/create-protocol-config.dto";
import { generateCa, signCert } from "./openvpn-pki";

@Injectable()
export class ProtocolConfigsService {
  constructor(private readonly prisma: PrismaService) {}

  list(nodeId?: string) {
    return this.prisma.protocolConfig.findMany({
      where: nodeId ? { nodeId } : undefined,
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string) {
    const config = await this.prisma.protocolConfig.findUnique({ where: { id } });
    if (!config) {
      throw new NotFoundException("Protocol config not found");
    }
    return config;
  }

  create(dto: CreateProtocolConfigDto) {
    const publicParamsJson = dto.publicParamsJson;

    // OpenVPN needs a CA + server cert to exist before any client cert
    // can be signed, and (unlike Xray/WireGuard's server secrets, which
    // stay node-local) the CA has to live wherever client certs get
    // signed -- see openvpn-pki.ts. Generated once, here, automatically,
    // rather than requiring an admin to run a separate setup step.
    if (dto.protocol === "OPENVPN") {
      const ca = generateCa(`NeoConnect OpenVPN CA ${dto.nodeId}`);
      const server = signCert(ca, "server", true);
      Object.assign(publicParamsJson, {
        caCertPem: ca.caCertPem,
        caKeyPem: ca.caKeyPem,
        serverCertPem: server.certPem,
        serverKeyPem: server.keyPem,
      });
    }

    return this.prisma.protocolConfig.create({
      data: {
        nodeId: dto.nodeId,
        protocol: dto.protocol,
        listenPort: dto.listenPort,
        publicParamsJson: publicParamsJson as Prisma.InputJsonValue,
        isEnabled: dto.isEnabled ?? true,
      },
    });
  }

  /** Same unhandled-FK-500 class of bug as Nodes/Plans (see those
   * services' remove() for the fuller writeup) -- ProtocolUsers (real
   * customer credentials) and Routes (entry or exit leg) both
   * represent state that must be explicitly torn down first, never
   * silently cascaded. */
  async remove(id: string) {
    await this.get(id);

    const [protocolUserCount, routeCount] = await Promise.all([
      this.prisma.protocolUser.count({ where: { protocolConfigId: id } }),
      this.prisma.route.count({ where: { OR: [{ entryProtocolConfigId: id }, { exitProtocolConfigId: id }] } }),
    ]);
    if (protocolUserCount > 0) {
      throw new BadRequestException(
        `Cannot delete this protocol config -- ${protocolUserCount} customer(s) are still provisioned on it.`,
      );
    }
    if (routeCount > 0) {
      throw new BadRequestException(
        `Cannot delete this protocol config -- ${routeCount} route(s) still use it as an entry or exit leg. Remove those first.`,
      );
    }

    await this.prisma.protocolConfig.delete({ where: { id } });
  }
}
