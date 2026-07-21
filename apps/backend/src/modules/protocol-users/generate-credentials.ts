import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Protocol } from "@prisma/client";

/** Generates protocol-specific credentials for a new ProtocolUser and the
 * externalUserId used to key it on the agent side (Xray's per-user
 * "email" stat key today; WireGuard's peer pubkey, OpenVPN's CN, etc.
 * once those land). One function per supported protocol -- deliberately
 * throws for protocols without a real provisioner yet (M4/M8) rather
 * than returning fake credentials nothing can use. */
export function generateCredentials(protocol: Protocol): {
  externalUserId: string;
  credentials: Record<string, string>;
} {
  switch (protocol) {
    case Protocol.XRAY_VLESS_REALITY: {
      const uuid = randomUUID();
      return { externalUserId: uuid, credentials: { uuid, flow: "xtls-rprx-vision" } };
    }
    default:
      throw new BadRequestException(`No provisioner implemented yet for protocol ${protocol}`);
  }
}
