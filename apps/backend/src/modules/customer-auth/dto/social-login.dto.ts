import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class SocialLoginDto {
  /** Which provider minted the token below. Not inferred from the token
   * itself: the three have different shapes and different verification
   * paths, and guessing would mean trying each in turn -- which is both
   * slower and a way to have a Facebook token accidentally validated as
   * something else. */
  @IsIn(["google", "apple", "facebook"])
  provider!: "google" | "apple" | "facebook";

  /** Google: the id_token. Apple: the identityToken from the native
   * sheet. Facebook: the access token.
   *
   * Length-capped because this is unauthenticated input that gets
   * base64-decoded and JSON-parsed; 8KB is far above any real token and
   * far below anything worth worrying about. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(8192)
  token!: string;

  /** The language the app is in, so a brand-new account gets its email
   * in the right one from the first message. Same field the password
   * signup sends. */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}
