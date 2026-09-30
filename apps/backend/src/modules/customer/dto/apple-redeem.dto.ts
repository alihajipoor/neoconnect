import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class AppleRedeemDto {
  /** The JWS StoreKit 2 hands the app for a completed purchase.
   *
   * Length-capped because this is parsed and base64-decoded before any
   * of it is trusted, and it arrives from a device we do not control.
   * A real transaction is a couple of kilobytes -- the certificate
   * chain is most of it -- so 16KB is far above anything genuine and
   * far below anything worth worrying about.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(16384)
  signedTransaction!: string;
}
