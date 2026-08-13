import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";

export class GenerateVoucherDto {
  @IsUUID()
  planId!: string;

  /** Optional: leaving it out mints a bare code to hand over in person,
   * which the reseller UI offers deliberately. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  recipientEmail?: string;
}

export class ResendVoucherDto {
  /** Send somewhere other than the address recorded on the code -- the
   * common case being a typo in the original. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;
}

export class SetBalanceDto {
  @IsUUID()
  planId!: string;

  /**
   * The absolute number of tokens the reseller should now hold, not an
   * amount to add. A form that submits twice must not grant twice.
   *
   * Upper bound is a guard against a typo, not a policy: someone
   * entering 100000 into a quantity box has almost certainly slipped,
   * and the cost of that mistake is free subscriptions.
   */
  @IsInt()
  @Min(0)
  @Max(10_000)
  balance!: number;
}
