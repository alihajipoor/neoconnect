import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, Length, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CreateCustomerDto } from "../../customers/dto/create-customer.dto";
import { ChallengeSolutionDto } from "../../login-guard/dto/challenge-solution.dto";

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

  /** The language the client is currently showing, so the emails this
   * signup triggers are in it.
   *
   * Here rather than on CreateCustomerDto for the same reason
   * `referralCode` is: an admin creating an account by hand is not
   * looking at the customer's screen and has no idea what language they
   * read, so a field they could set would be a field set wrongly.
   *
   * Optional, because a client older than this change does not send it
   * and must not start failing to register. Its absence means "en", which
   * is what those clients' customers have been getting anyway.
   *
   * `IsIn` rather than a free string: this ends up in a column the email
   * templates index a strings table with, and while `toLocale()` narrows
   * anything unrecognised on the way out, there is no reason to store a
   * value we would only ever throw away. */
  @ApiPropertyOptional({ enum: ["en", "fa"] })
  @IsOptional()
  @IsIn(["en", "fa"])
  locale?: "en" | "fa";

  /** Solved proof-of-work, when the client supports it. Optional for the
   * same back-compatibility reason as on LoginDto. */
  @ApiPropertyOptional({ type: () => ChallengeSolutionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChallengeSolutionDto)
  challenge?: ChallengeSolutionDto;
}
