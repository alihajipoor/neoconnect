import { IsString } from "class-validator";
import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";

export class UnverifiedEmailDto {
  @NormalizedEmail()
  email!: string;

  @NormalizedEmail()
  emailConfirm!: string;

  @IsString()
  password!: string;
}
