import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsUUID, Max, Min } from "class-validator";
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

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
