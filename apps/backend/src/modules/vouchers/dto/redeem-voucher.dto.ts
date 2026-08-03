import { IsString, Length } from "class-validator";

export class RedeemVoucherDto {
  /** Accepted with whatever spacing or dashes the customer typed; the
   * service normalises before looking it up. */
  @IsString()
  @Length(4, 80)
  code!: string;
}
