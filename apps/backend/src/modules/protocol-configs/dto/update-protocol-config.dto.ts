import { IsBoolean, IsInt, IsObject, IsOptional, Max, Min } from "class-validator";

/** Deliberately cannot change `nodeId` or `protocol`.
 *
 * Both are baked into every ProtocolUser already provisioned against
 * this config -- the node is where their agent commands get sent, and
 * the protocol determines the shape of their credentials. Editing either
 * would silently invalidate live customer connections while looking like
 * a routine correction, so those require deleting and recreating (which
 * forces the existing users to be dealt with explicitly). */
export class UpdateProtocolConfigDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  listenPort?: number;

  @IsOptional()
  @IsObject()
  publicParamsJson?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
