import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";
import { IsOptional, IsString, MinLength } from "class-validator";

export class CreateCustomerDto {
  @NormalizedEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  telegramId?: string;
}
