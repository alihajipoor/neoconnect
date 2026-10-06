import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class ClaimSlotDto {
  /** The subscription the device is about to connect with. */
  @IsUUID()
  subscriptionId!: string;

  /** The credential (GET /customer/protocol-users `id`) the device is
   * connecting with. Optional. When it is one of the subscription's
   * shared credentials, its traffic counts as this device's. */
  @IsOptional()
  @IsUUID()
  protocolUserId?: string;

  /** Handles from a 409 DEVICE_LIMIT response: take those devices' slots
   * over. Only after the customer chose "Use on this device instead". */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  takeover?: string[];
}

export class RenewSlotDto {
  @IsUUID()
  subscriptionId!: string;
}

export class ReleaseSlotDto {
  /** Omitted: every subscription's slot this device holds. */
  @IsOptional()
  @IsUUID()
  subscriptionId?: string;

  /** The `handle` of the grant being given back -- the latest claim's (or
   * the renewal's that re-granted). A slot held under a newer grant is
   * then left alone. Omitted: whatever this device holds. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  handle?: string;
}
