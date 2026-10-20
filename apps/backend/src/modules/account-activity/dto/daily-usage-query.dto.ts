import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { DEFAULT_DAYS, MAX_DAYS } from "../daily-usage.service";

/** `GET /customer/subscriptions/:id/usage?days=30&tz=Asia/Tehran`. The
 * zone's name is checked against the runtime's tz database by the
 * service, which answers 400 UNKNOWN_TIME_ZONE for one it does not know. */
export class DailyUsageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_DAYS, default: DEFAULT_DAYS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DAYS)
  days?: number;

  @ApiPropertyOptional({ description: "IANA time zone the days are counted in", default: "UTC" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tz?: string;
}
