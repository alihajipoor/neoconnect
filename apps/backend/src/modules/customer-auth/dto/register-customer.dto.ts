import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, Length } from "class-validator";
import { CreateCustomerDto } from "../../customers/dto/create-customer.dto";

/** Signup, which is [`CreateCustomerDto`] plus the one thing only a
 * self-signing-up customer can supply.
 *
 * Kept separate from the admin create DTO rather than adding the field
 * there: an admin creating an account by hand is not being referred by
 * anyone, and a field that is always ignored on one of two paths is a
 * field somebody will eventually set on the wrong one. */
export class RegisterCustomerDto extends CreateCustomerDto {
  /** A friend's referral code, as typed. Length-bounded because codes
   * are fixed-width hex and anything else is a paste accident -- caught
   * here rather than turned into a database lookup. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(4, 32)
  referralCode?: string;
}
