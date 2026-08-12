import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";
import { IsOptional, IsString, MinLength, ValidateNested } from "class-validator";
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
}
