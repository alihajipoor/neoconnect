import { IsOptional, IsString } from "class-validator";

export class RecoveryCodeDto {
  /** Required for an account that has a password; an account without one
   * re-authenticates by having signed in within the last fifteen minutes. */
  @IsOptional()
  @IsString()
  currentPassword?: string;
}
