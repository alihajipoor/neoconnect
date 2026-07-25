import { IsEnum, IsOptional, IsString, MinLength } from "class-validator";
import { CustomerStatus } from "@prisma/client";

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  telegramId?: string;

  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;

  /** Sets a new password for the customer, for the support case where
   * someone is locked out and can't complete the self-serve reset (no
   * access to their inbox being the usual one).
   *
   * Same minimum as signup -- an admin-set password must not be allowed
   * to be weaker than one the customer could have chosen themselves.
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}
