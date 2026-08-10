import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";

export class ForgotPasswordDto {
  @NormalizedEmail()
  email!: string;
}
