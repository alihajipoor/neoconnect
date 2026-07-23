import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Protocol } from "@prisma/client";
import { signCert } from "../protocol-configs/openvpn-pki";
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

interface OpenVpnPublicParams {
  caCertPem: string;
  caKeyPem: string;
  endpoint: string;
  proto?: string;
}

function isOpenVpnPublicParams(value: unknown): value is OpenVpnPublicParams {
  const v = value as Record<string, unknown> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.caCertPem === "string" &&
    typeof v.caKeyPem === "string" &&
    typeof v.endpoint === "string"
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
    case Protocol.OPENVPN: {
      if (!isOpenVpnPublicParams(protocolConfig.publicParamsJson)) {
        throw new BadRequestException(
          "This node's OpenVPN ProtocolConfig is missing caCertPem/caKeyPem/endpoint in publicParamsJson",
        );
      }
      const { caCertPem, caKeyPem, endpoint, proto } = protocolConfig.publicParamsJson;
      // The CN doubles as this user's file name in the node's
      // client-config-dir (see agent/internal/protocols/openvpn) -- a
      // fresh cert is signed per user rather than sharing one, unlike
      // Xray/WireGuard's single-server-identity model, since OpenVPN's
      // client auth is the cert itself.
      const commonName = randomUUID();
      const { certPem, keyPem } = signCert({ caCertPem, caKeyPem }, commonName, false);
      return {
        externalUserId: commonName,
        credentials: {
          certPem,
          keyPem,
          caCertPem,
          commonName,
          endpoint,
          proto: proto ?? "udp",
        },
      };
    }
    default:
      throw new BadRequestException(`No provisioner implemented yet for protocol ${protocol}`);
  }
}
