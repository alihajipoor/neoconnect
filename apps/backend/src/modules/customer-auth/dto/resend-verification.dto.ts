import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";

export class ResendVerificationDto {
  @NormalizedEmail()
  email!: string;
}
