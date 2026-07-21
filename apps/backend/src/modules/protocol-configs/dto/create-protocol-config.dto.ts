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
   * XRAY_VLESS_REALITY: { realityPublicKey, shortIds, dest, serverName }.
   * Generated once per node via `xray x25519` (see installer), entered
   * here rather than auto-reported back over the wire -- see M3 scope
   * notes in docs/architecture.md. */
  @IsObject()
  publicParamsJson!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
