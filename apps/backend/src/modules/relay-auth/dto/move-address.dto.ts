import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length } from "class-validator";
import { NormalizedEmail } from "../../../common/decorators/normalized-email.decorator";

/** Support moving an account to a new address on its recovery code alone
 * (R3.9): the customer reads the code to support, who types it here. */
export class MoveAddressDto {
  @ApiProperty()
  @IsString()
  @Length(16, 40)
  recoveryCode!: string;

  @ApiProperty()
  @NormalizedEmail()
  email!: string;
}
