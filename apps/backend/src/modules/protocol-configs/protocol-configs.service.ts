import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Protocol, type Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateProtocolConfigDto } from "./dto/create-protocol-config.dto";
import { UpdateProtocolConfigDto } from "./dto/update-protocol-config.dto";
import { generateCa, signCert } from "./openvpn-pki";
import { decryptCredentials, encryptCredentials } from "../protocol-users/credentials-crypto";

/** publicParamsJson keys the backend owns, not the admin. An update must
 * carry these across untouched: they are generated once at create time
 * and everything already issued against them depends on them staying
 * exactly as they are. */
const SERVER_MANAGED_PUBLIC_PARAMS = ["caCertPem", "caKeyPem", "serverCertPem", "serverKeyPem"] as const;

/** The publicParamsJson keys an admin must supply per protocol, and what
 * each one is, so the error can say what to go and find rather than just
 * naming a key.
 *
 * Keys the backend fills in itself are deliberately absent: OpenVPN's
 * caCertPem/caKeyPem are generated below, and every protocol's server
 * secrets stay node-local by design (see M3/M4 notes in
 * docs/architecture.md). */
const REQUIRED_PUBLIC_PARAMS: Partial<Record<Protocol, Record<string, string>>> = {
  [Protocol.XRAY_VLESS_REALITY]: {
    realityPublicKey: "the public key printed by the installer's Xray step",
    shortIds: "a non-empty array of short IDs, e.g. [\"0123abcd\"]",
    dest: "the camouflage destination, e.g. \"www.microsoft.com:443\"",
    serverName: "the SNI, i.e. dest without its port",
  },
  [Protocol.WIREGUARD]: {
    serverPublicKey: "output of `wg show wg0 public-key` on the node",
    endpoint: "this node's public host:port, e.g. \"203.0.113.5:51820\"",
    subnetCidr: "the tunnel subnet, e.g. \"10.77.0.0/24\"",
  },
  [Protocol.OPENVPN]: {
    endpoint: "this node's public host:port, e.g. \"203.0.113.5:1194\"",
  },
};

/** Rejects a config that would provision fine and then fail at the point
 * a customer actually tries to connect.
 *
 * This validation exists because that is precisely what happened: three
 * protocol configs were registered with empty publicParamsJson, passed
 * `@IsObject()`, and produced no error until the client app -- days
 * later, on someone's desktop -- reported a missing key it could do
 * nothing about. The cost of the mistake landed as far as possible from
 * where it was made, so it is worth catching at the only moment the
 * admin still has the installer output in front of them. */
function assertRequiredPublicParams(protocol: Protocol, params: Record<string, unknown>): void {
  const required = REQUIRED_PUBLIC_PARAMS[protocol];
  if (!required) return;

  const missing = Object.entries(required).filter(([key]) => {
    const value = params[key];
    if (value === undefined || value === null || value === "") return true;
    // shortIds is the one array here, and an empty array is just as
    // unusable to a client as an absent key.
    if (Array.isArray(value)) return value.length === 0;
    return false;
  });

  if (missing.length > 0) {
    const details = missing.map(([key, hint]) => `${key} (${hint})`).join("; ");
    throw new BadRequestException(
      `This ${protocol} config is missing required publicParamsJson values, and clients can't connect without them: ${details}. ` +
        "The installer prints these when it sets the protocol up on the node.",
    );
  }
}

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

  async create(dto: CreateProtocolConfigDto) {
    // The installer's "Install/reconfigure <protocol>" menu wording implies
    // re-running it is safe, but it isn't at the API level: this would
    // otherwise hit the (nodeId, protocol, listenPort) unique constraint and
    // surface as an unhandled Prisma error -- a raw 500 with no indication
    // of what actually went wrong (this is exactly what happened live: a
    // node that already had all three protocols registered hit this on a
    // second OpenVPN install attempt). A pre-check with a clear message is
    // also the *safer* answer, not just a nicer error: silently overwriting
    // would be actively dangerous for OpenVPN specifically (a fresh
    // Object.assign below would mint a brand-new CA, invalidating every
    // client cert already issued against the old one), and pointless for
    // Xray/WireGuard (their installers already regenerated fresh node-local
    // keys on re-run, so the old publicParamsJson here would just go stale
    // instead of being replaced).
    // Transport is part of the identity: the same protocol on the same
    // port carried two ways is two configs, not a clash. VLESS over TLS
    // and VLESS inside a WebSocket share a port deliberately.
    const transport = dto.transport ?? "TCP";
    const existing = await this.prisma.protocolConfig.findUnique({
      where: {
        nodeId_protocol_listenPort_transport: {
          nodeId: dto.nodeId,
          protocol: dto.protocol,
          listenPort: dto.listenPort,
          transport,
        },
      },
    });
    if (existing) {
      throw new ConflictException(
        `A ${dto.protocol} protocol config already exists on this node at port ${dto.listenPort} over ${transport} (id ${existing.id}). ` +
          "Delete it first if you're genuinely reconfiguring -- note that for OPENVPN this invalidates every client cert already issued against its CA.",
      );
    }

    assertRequiredPublicParams(dto.protocol, dto.publicParamsJson);

    const publicParamsJson = dto.publicParamsJson;

    // OpenVPN needs a CA + server cert to exist before any client cert
    // can be signed, and (unlike Xray/WireGuard's server secrets, which
    // stay node-local) the CA has to live wherever client certs get
    // signed -- see openvpn-pki.ts. Generated once, here, automatically,
    // rather than requiring an admin to run a separate setup step.
    if (dto.protocol === "OPENVPN") {
      const ca = generateCa(`Neoxify OpenVPN CA ${dto.nodeId}`);
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

  /** Corrects a config in place -- the repair path for a config that was
   * registered with wrong or missing publicParamsJson.
   *
   * This exists because there was previously no way to fix one: the API
   * offered only create and delete, and delete is refused while any
   * customer or route still references the config. A node whose params
   * were entered wrong was therefore unfixable without tearing down live
   * customer provisioning first, which is a bad trade for correcting a
   * typo.
   *
   * Server-managed values are preserved rather than overwritten. This
   * matters most for OPENVPN: its CA lives in publicParamsJson, and
   * every client certificate ever issued was signed by it, so letting a
   * PATCH body replace the whole object would invalidate every existing
   * customer's certificate as a side effect of correcting an endpoint. */
  async update(id: string, dto: UpdateProtocolConfigDto) {
    const existing = await this.get(id);

    let publicParamsJson = existing.publicParamsJson as Record<string, unknown>;
    if (dto.publicParamsJson) {
      const preserved: Record<string, unknown> = {};
      for (const key of SERVER_MANAGED_PUBLIC_PARAMS) {
        if (publicParamsJson?.[key] !== undefined) {
          preserved[key] = publicParamsJson[key];
        }
      }
      // Caller's values first, preserved keys last: an admin cannot
      // clobber the CA even by explicitly sending a different one.
      publicParamsJson = { ...dto.publicParamsJson, ...preserved };
      assertRequiredPublicParams(existing.protocol, publicParamsJson);
    }

    if (dto.listenPort !== undefined && dto.listenPort !== existing.listenPort) {
      const clash = await this.prisma.protocolConfig.findUnique({
        where: {
          nodeId_protocol_listenPort_transport: {
            nodeId: existing.nodeId,
            protocol: existing.protocol,
            listenPort: dto.listenPort,
            // The row's own transport: an update can move the port but
            // not the carrier, so the question is whether that port is
            // already taken by a config carried the same way. A
            // WebSocket sibling there is not a collision -- sharing a
            // port is the design.
            transport: existing.transport,
          },
        },
      });
      if (clash) {
        throw new ConflictException(
          `Another ${existing.protocol} config already uses port ${dto.listenPort} on this node over ${existing.transport} (id ${clash.id}).`,
        );
      }
    }

    const updated = await this.prisma.protocolConfig.update({
      where: { id },
      data: {
        ...(dto.listenPort !== undefined ? { listenPort: dto.listenPort } : {}),
        ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
        ...(dto.publicParamsJson ? { publicParamsJson: publicParamsJson as Prisma.InputJsonValue } : {}),
      },
    });

    // Passed explicitly rather than read back off `updated`: the
    // protocol never changes here, and the params are already computed
    // above. Taking them from the return value would make this depend
    // on exactly which columns the write happened to echo back.
    await this.rewriteIssuedEndpoints(id, existing.protocol, publicParamsJson);
    return updated;
  }

  /**
   * Carries an endpoint change into credentials that were already issued.
   *
   * WireGuard and OpenVPN are the two protocols whose per-customer
   * credentials embed the server's address and port -- baked in at
   * generation, because both formats are a complete config file rather
   * than a set of fields the client assembles. Everything else reads
   * host and port from the `connection` block, which is derived fresh
   * on every request and needs nothing done to it.
   *
   * Without this, moving a port did exactly half a migration: the row
   * said the new port, the node listened on the new port, and every
   * customer already provisioned went on dialling the old one until
   * somebody deleted and recreated them by hand. Nothing reported it,
   * because from the panel's point of view the change had succeeded.
   *
   * Only the endpoint is rewritten. Regenerating the credentials
   * outright would hand out a new WireGuard key and consume another
   * address from the node's pool, or reissue an OpenVPN certificate --
   * churn that a port change does not call for, and that would drop
   * anyone currently connected.
   */
  private async rewriteIssuedEndpoints(
    configId: string,
    protocol: Protocol,
    publicParamsJson: Record<string, unknown> | undefined,
  ) {
    if (protocol !== Protocol.WIREGUARD && protocol !== Protocol.OPENVPN) {
      return;
    }

    const endpoint = typeof publicParamsJson?.endpoint === "string" ? publicParamsJson.endpoint : null;
    if (!endpoint) return;

    const users = await this.prisma.protocolUser.findMany({
      where: { protocolConfigId: configId },
      select: { id: true, credentialsJson: true },
    });

    for (const user of users) {
      const credentials = decryptCredentials(user.credentialsJson);
      if (credentials.endpoint === endpoint) continue;
      await this.prisma.protocolUser.update({
        where: { id: user.id },
        data: { credentialsJson: encryptCredentials({ ...credentials, endpoint }) },
      });
    }
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
