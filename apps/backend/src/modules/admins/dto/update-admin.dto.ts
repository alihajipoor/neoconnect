import { IsEnum, IsOptional, IsString, MinLength } from "class-validator";
import { AdminRole } from "@prisma/client";

export class UpdateAdminDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;
}
