import { IsEmail, IsEnum, IsString, MinLength } from "class-validator";
import { AdminRole } from "@prisma/client";

export class CreateAdminDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsEnum(AdminRole)
  role!: AdminRole;
}
