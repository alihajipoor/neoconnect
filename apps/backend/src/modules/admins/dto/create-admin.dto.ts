import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";
import { IsEnum, IsString, MinLength } from "class-validator";
import { AdminRole } from "@prisma/client";

export class CreateAdminDto {
  @NormalizedEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsEnum(AdminRole)
  role!: AdminRole;
}
