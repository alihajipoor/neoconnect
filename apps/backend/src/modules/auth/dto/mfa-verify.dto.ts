import { IsBoolean, IsOptional, IsString, Length, MaxLength } from "class-validator";

export class MfaVerifyDto {
  @IsString()
  mfaToken!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  /** "Trust this device for 30 days". Off unless sent as true. */
  @IsOptional()
  @IsBoolean()
  trustDevice?: boolean;

  /** The browser's User-Agent, forwarded by the panel's server, for the
   * trusted device's label. Display only. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;
}
