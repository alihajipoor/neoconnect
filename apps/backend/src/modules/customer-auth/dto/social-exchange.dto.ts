import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class SocialExchangeDto {
  /** The one-time code the browser flow handed back through the app's
   * redirect. Not a provider token and not a session -- it is worth
   * nothing except to whoever can also reach this endpoint, and only
   * once. See OauthFlowService for why the session is collected this
   * way instead of being put in the redirect.
   *
   * 512 is far above the 43 characters a 32-byte base64url value takes
   * and far below anything worth a second thought. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  code!: string;
}
