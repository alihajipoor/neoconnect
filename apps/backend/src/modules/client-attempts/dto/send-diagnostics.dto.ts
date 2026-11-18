import { Type } from "class-transformer";
import { IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { ReportDetailsDto } from "./report-details.dto";

/** The longest "Copy diagnostics" text accepted: what the desktop apps
 * already produce and show the customer, with room. */
export const PLATFORM_DIAGNOSTICS_MAX_LENGTH = 16_000;
export const DIAGNOSTICS_NOTE_MAX_LENGTH = 500;

/** POST /customer/diagnostics: a bundle the customer chose to send. */
export class SendDiagnosticsDto {
  @IsString()
  @MaxLength(32)
  platform!: string;

  @IsString()
  @MaxLength(32)
  appVersion!: string;

  /** The customer's own words, if any. */
  @IsOptional()
  @IsString()
  @MaxLength(DIAGNOSTICS_NOTE_MAX_LENGTH)
  note?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ReportDetailsDto)
  details?: ReportDetailsDto;

  @IsOptional()
  @IsString()
  @MaxLength(PLATFORM_DIAGNOSTICS_MAX_LENGTH)
  platformDiagnostics?: string;
}
