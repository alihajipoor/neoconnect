import { IsEmail, IsOptional, IsString, MinLength } from "class-validator";

export class CreateCustomerDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  telegramId?: string;
}
