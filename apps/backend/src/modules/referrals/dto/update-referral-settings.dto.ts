import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";

export class UpdateReferralSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Which plan a free month is granted on. Null turns the reward off
   * without turning the programme off -- referrals still accumulate, so
   * nothing is lost while the operator decides. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  rewardPlanId?: string | null;

  /** Cumulative paid months from one invited customer that earn a
   * reward. Bounded so a typo cannot make the programme unwinnable (or
   * accidentally give a month away for a single day's subscription). */
  @ApiPropertyOptional({ minimum: 1, maximum: 36 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36)
  loyalFriendMonths?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  friendsRequired?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 36 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36)
  friendMonths?: number;

  /** How long the granted subscription runs, in days. Capped at a year:
   * this is a thank-you, and a mis-typed value here gives away real
   * service with no payment behind it. */
  @ApiPropertyOptional({ minimum: 1, maximum: 365 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  rewardDays?: number;
}
