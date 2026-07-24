import { IsString, Length } from "class-validator";

export class MfaEnableDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}
