import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";
import { IsOptional, IsString, MaxLength, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { ChallengeSolutionDto } from "../../login-guard/dto/challenge-solution.dto";

export class LoginDto {
  @NormalizedEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  /**
   * Optional so that clients already in the field keep working; the
   * LoginGuardService decides when it stops being optional.
   *
   * Must be declared even though it is optional -- the global
   * ValidationPipe runs with forbidNonWhitelisted, so an undeclared
   * property would make the whole request 400 rather than being
   * ignored.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => ChallengeSolutionDto)
  challenge?: ChallengeSolutionDto;

  /** The token from the browser's trusted-device cookie, sent on by the
   * panel's server. Stands in for the code only after a right password
   * (AuthService.login). */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  trustedDevice?: string;
}
