import { IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength } from "class-validator";

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

  /** The PKCE verifier (RFC 7636) whose challenge the app sent to
   * `/social/:provider/start`. Optional only for clients released before
   * the binding; see OauthFlowService.consumeHandoff. 43 to 128
   * unreserved characters, as the RFC defines it. */
  @IsOptional()
  @IsString()
  @Length(43, 128)
  @Matches(/^[A-Za-z0-9._~-]+$/)
  verifier?: string;
}
