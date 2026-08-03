import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class UpdateSupportSettingsDto {
  /** The away switch. Off closes new conversations only -- threads
   * already running stay open, so nobody is cut off mid-sentence. */
  @IsOptional()
  @IsBoolean()
  acceptingTickets?: boolean;

  /** Shown in the app in place of the compose box while closed. Empty
   * string clears it back to the app's own default wording. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  awayMessage?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(336)
  replyWithinHours?: number;
}
