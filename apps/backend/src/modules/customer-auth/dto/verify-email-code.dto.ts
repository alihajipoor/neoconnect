import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";
import { IsString, Length } from "class-validator";

export class VerifyEmailCodeDto {
  @NormalizedEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
