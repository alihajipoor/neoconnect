import { IsEnum, IsOptional, IsString } from "class-validator";
import { CustomerStatus } from "@prisma/client";

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  telegramId?: string;

  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;
}
