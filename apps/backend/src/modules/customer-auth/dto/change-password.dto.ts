import { IsString, MinLength } from "class-validator";

export class ChangePasswordDto {
  /** Required even though the caller is already authenticated. A stolen
   * or borrowed session must not be enough to lock the real owner out by
   * changing their password. */
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
