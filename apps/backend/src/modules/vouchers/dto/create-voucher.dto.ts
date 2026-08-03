import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from "class-validator";

export class CreateVoucherDto {
  @IsUUID()
  planId!: string;

  /** Left out to have one generated. Supplied when the operator wants a
   * memorable code for a campaign rather than a random one. */
  @IsOptional()
  @IsString()
  @Length(4, 64)
  code?: string;

  /** Omitted means unlimited redemptions; 1 is a one-time code. The two
   * limits compose -- a code can be both capped and expiring. */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  /** Omitted means it never expires. */
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  note?: string;
}
