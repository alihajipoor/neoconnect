import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Protocol } from "@prisma/client";
import { generateWireGuardKeypair } from "./wireguard-keys";
import { allocateWireGuardAddress } from "./wireguard-subnet";

interface WireGuardPublicParams {
  serverPublicKey: string;
  endpoint: string;
  subnetCidr: string;
  dns?: string;
}

function isWireGuardPublicParams(value: unknown): value is WireGuardPublicParams {
  const v = value as Record<string, unknown> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.serverPublicKey === "string" &&
    typeof v.endpoint === "string" &&
    typeof v.subnetCidr === "string"
  );
}

/** Generates protocol-specific credentials for a new ProtocolUser and the
 * externalUserId used to key it on the agent side (Xray's per-user
 * "email" stat key, WireGuard's peer pubkey, OpenVPN's CN once M8
 * lands). One function per supported protocol -- deliberately throws for
 * protocols without a real provisioner yet rather than returning fake
 * credentials nothing can use. The returned `credentials` are stored
 * verbatim as ProtocolUser.credentialsJson and also sent to the agent as
 * the AgentCommand payload, so for WireGuard they carry everything a
 * native client needs to build its own tunnel directly (private key,
 * assigned address, server pubkey/endpoint/DNS) -- see the
 * native-client-format note in project memory. */
export function generateCredentials(
  protocol: Protocol,
  protocolConfig: { publicParamsJson: unknown },
  usedAddresses: string[],
): {
  externalUserId: string;
  credentials: Record<string, string>;
} {
  switch (protocol) {
    case Protocol.XRAY_VLESS_REALITY: {
      const uuid = randomUUID();
      return { externalUserId: uuid, credentials: { uuid, flow: "xtls-rprx-vision" } };
    }
    case Protocol.WIREGUARD: {
      if (!isWireGuardPublicParams(protocolConfig.publicParamsJson)) {
        throw new BadRequestException(
          "This node's WireGuard ProtocolConfig is missing serverPublicKey/endpoint/subnetCidr in publicParamsJson",
        );
      }
      const { serverPublicKey, endpoint, subnetCidr, dns } = protocolConfig.publicParamsJson;
      const address = allocateWireGuardAddress(subnetCidr, usedAddresses);
      const { privateKey, publicKey } = generateWireGuardKeypair();
      return {
        externalUserId: publicKey,
        credentials: {
          privateKey,
          publicKey,
          address: `${address}/32`,
          dns: dns ?? "1.1.1.1",
          allowedIPs: "0.0.0.0/0, ::/0",
          serverPublicKey,
          endpoint,
        },
      };
    }
    default:
      throw new BadRequestException(`No provisioner implemented yet for protocol ${protocol}`);
  }
}
