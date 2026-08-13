import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, Min } from "class-validator";
import { Protocol, Transport, TransportSecurity } from "@prisma/client";

export class CreateProtocolConfigDto {
  @IsUUID()
  nodeId!: string;

  @IsEnum(Protocol)
  protocol!: Protocol;

  @IsInt()
  @Min(1)
  @Max(65535)
  listenPort!: number;

  /** Protocol-specific public parameters clients need to connect -- for
   * XRAY_VLESS_REALITY: { realityPublicKey, shortIds, dest, serverName };
   * for WIREGUARD: { serverPublicKey, endpoint, subnetCidr, dns }.
   * Generated once per node via the installer's `install_xray`/
   * `install_wireguard`, entered here rather than auto-reported back
   * over the wire -- see M3/M4 scope notes in docs/architecture.md. */
  @IsObject()
  publicParamsJson!: Record<string, unknown>;

  /** How this inbound is carried, and what it is wrapped in.
   *
   * Separate from `protocol` because one Xray protocol is offered several
   * ways -- VLESS over plain TCP with REALITY is a different thing on the
   * wire from VLESS over WebSocket with TLS, and enumerating every
   * combination as its own Protocol member does not scale. Defaults
   * (TCP/NONE) are deliberately the dullest option, so a caller that
   * says nothing does not accidentally claim TLS it isn't serving. */
  @IsOptional()
  @IsEnum(Transport)
  transport?: Transport;

  @IsOptional()
  @IsEnum(TransportSecurity)
  security?: TransportSecurity;

  /** Which Xray inbound on the node serves this config.
   *
   * Omit for the node's default inbound for that protocol -- the tag the
   * agent was started with, which is what every ordinary node uses.
   *
   * Set it when a node runs more than one inbound of the same protocol.
   * That happens on a relay serving several exits: a relayed route's
   * routing rule matches on the entry inbound tag and nothing else, so
   * two routes sharing an inbound means the second silently egresses
   * through the first one's exit. A second listener with its own tag is
   * what keeps them apart. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{1,64}$/, {
    message: "inboundTag must match the tag in the node's Xray config (lowercase letters, digits and dashes)",
  })
  inboundTag?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
