import { IsString, MinLength } from "class-validator";

export class MfaDisableDto {
  @IsString()
  @MinLength(8)
  password!: string;
}
