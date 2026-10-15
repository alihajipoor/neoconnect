import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsDefined, IsIn, IsOptional, IsString, Length, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";
import { ChallengeSolutionDto } from "../../login-guard/dto/challenge-solution.dto";

/** Sign-up through the Iranian relay (docs/relay-last-resort.md, R3). */
export class RelayRegisterDto {
  @ApiProperty()
  @NormalizedEmail()
  email!: string;

  /** The address typed a second time. Nothing confirms it otherwise, and a
   * typo here is a paid account that can never be verified (F9). */
  @ApiProperty()
  @NormalizedEmail()
  emailConfirm!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  password!: string;

  /** Accepted so an app that sends one is not refused, and ignored. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(4, 32)
  referralCode?: string;

  @ApiPropertyOptional({ enum: ["en", "fa"] })
  @IsOptional()
  @IsIn(["en", "fa"])
  locale?: "en" | "fa";

  /** Required here, unlike everywhere else: the relay has no grace. */
  @ApiProperty({ type: () => ChallengeSolutionDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ChallengeSolutionDto)
  challenge!: ChallengeSolutionDto;
}
