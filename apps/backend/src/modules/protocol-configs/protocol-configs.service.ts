import { Injectable, NotFoundException } from "@nestjs/common";
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

  async remove(id: string) {
    await this.get(id);
    await this.prisma.protocolConfig.delete({ where: { id } });
  }
}
