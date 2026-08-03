import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, IsUUID, Length, Min } from "class-validator";

/** Everything about a voucher except its code.
 *
 * The code is deliberately not editable: it may already be printed on
 * something or sitting in somebody's inbox, and changing it would break
 * that silently. Stopping a live code is what `isActive` is for. */
export class UpdateVoucherDto {
  @IsOptional()
  @IsUUID()
  planId?: string;

  /** Explicitly nullable: clearing it makes the voucher unlimited. */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number | null;

  /** Explicitly nullable: clearing it makes the voucher never expire. */
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  note?: string;
}
