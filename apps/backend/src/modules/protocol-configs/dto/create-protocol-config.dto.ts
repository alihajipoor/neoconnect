import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsUUID, Max, Min } from "class-validator";
import { Protocol } from "@prisma/client";

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

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
