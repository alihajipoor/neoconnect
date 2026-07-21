import { IsBoolean, IsOptional, IsString, IsUUID } from "class-validator";

export class CreateRouteDto {
  @IsString()
  name!: string;

  @IsUUID()
  entryProtocolConfigId!: string;

  /** Set only for relayed routes -- must reference an XRAY_VLESS_REALITY
   * ProtocolConfig on an EXIT node. Omitted = direct route (client
   * connects straight to entryProtocolConfigId, as in M2-M4). */
  @IsOptional()
  @IsUUID()
  exitProtocolConfigId?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
