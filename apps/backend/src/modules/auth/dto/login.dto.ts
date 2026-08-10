import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";
import { IsString, MinLength } from "class-validator";

export class LoginDto {
  @NormalizedEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
