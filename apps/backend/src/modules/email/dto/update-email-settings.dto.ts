import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class UpdateEmailSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @IsOptional()
  @IsString()
  username?: string;

  // Omit (undefined) to keep the currently-stored password unchanged --
  // the GET response never returns it, so a panel edit that only changes
  // e.g. the host must not accidentally blank the password out.
  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsEmail()
  fromAddress?: string;
}
