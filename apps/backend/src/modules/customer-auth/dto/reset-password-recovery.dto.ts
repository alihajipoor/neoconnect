import { IsString, Length, MinLength } from "class-validator";
import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";

export class ResetPasswordRecoveryDto {
  @NormalizedEmail()
  email!: string;

  /** Sixteen base32 characters, typed however: grouped, spaced, any case. */
  @IsString()
  @Length(16, 40)
  recoveryCode!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
