import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { LoginGuardService } from "../login-guard/login-guard.service";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CustomerAuthService } from "./customer-auth.service";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { CurrentCustomer } from "../../common/decorators/current-customer.decorator";
import { AuthenticatedCustomer } from "./types";
import { RegisterCustomerDto } from "./dto/register-customer.dto";
import { LoginDto } from "../auth/dto/login.dto";
import { SocialLoginDto } from "./dto/social-login.dto";
import { SocialExchangeDto } from "./dto/social-exchange.dto";
import { SocialAuthService } from "./social/social-auth.service";
import { OauthFlowService, type BrowserProvider } from "./social/oauth-flow.service";
import { RefreshDto } from "../auth/dto/refresh.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { VerifyEmailCodeDto } from "./dto/verify-email-code.dto";
import { ResendVerificationDto } from "./dto/resend-verification.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { verificationFailedPage, verifiedPage } from "./verify-landing-page";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { ResetPasswordCodeDto } from "./dto/reset-password-code.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { deviceInfoFrom } from "../../common/device-info";

type HeaderBag = Record<string, string | string[] | undefined>;

// This is the API a future native client (Windows/macOS/Android/iOS)
// signs up and logs in through -- there is deliberately no web UI for
// any of this (see the "Customer Self-Signup + Free Trial Mode" plan
// section): the native clients are Phase 2 and don't exist yet, so this
// milestone is API-only, same precedent as Nodes/Routes before their
// panel UI existed (or, for Routes, still does).
@ApiTags("customer-auth")
@Controller("customer-auth")
export class CustomerAuthController {
  constructor(
    private readonly customerAuthService: CustomerAuthService,
    private readonly loginGuard: LoginGuardService,
    private readonly socialAuth: SocialAuthService,
    private readonly oauthFlow: OauthFlowService,
  ) {}

  // Same brute-force reasoning as admin login. Registration no longer
  // grants a free trial directly (see CustomerAuthService.register()'s
  // doc comment) -- verify-email is the actual free-VPN-abuse gate now,
  // rate limiting here is just standard signup-endpoint hygiene.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register")
  @HttpCode(HttpStatus.OK)
  register(@Body() dto: RegisterCustomerDto, @Ip() ip: string) {
    // Challenge enforced, but a failure here is deliberately NOT
    // recorded against the address being registered. Doing so would let
    // anyone raise a real customer's login difficulty just by
    // repeatedly attempting to register their email -- turning a
    // protection into a way to slow down the person it protects.
    this.loginGuard.enforce("customer", dto.challenge, undefined, ip);
    return this.customerAuthService.register(dto);
  }

  /** Sign in with Google, Apple or Facebook.
   *
   * Throttled like password login and for the same reason -- the
   * expensive part is a network round trip to the provider, so an
   * unthrottled endpoint is a way to make this server hammer Google on
   * someone else's behalf.
   *
   * Deliberately outside the login guard's challenge: the guard exists
   * to slow password guessing against a known address, and there is no
   * password and no address here until the provider has answered. A
   * token either verifies or it does not; there is nothing to guess.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("social")
  @HttpCode(HttpStatus.OK)
  async social(@Body() dto: SocialLoginDto, @Headers() headers: HeaderBag) {
    const provider = dto.provider.toUpperCase() as "GOOGLE" | "APPLE" | "FACEBOOK";
    const identity = await this.socialAuth.verify(provider, dto.token);
    const { customer, created } = await this.socialAuth.resolveCustomer(provider, identity, dto.locale ?? "en");
    if (created) await this.customerAuthService.onSocialSignup(customer.id);
    return this.customerAuthService.issueTokenPair(customer, undefined, deviceInfoFrom(headers));
  }

  private browserProvider(raw: string): BrowserProvider {
    if (raw !== "google" && raw !== "facebook") {
      // Apple is a real provider but not a browser one -- it arrives at
      // POST /social with a native token. Saying so beats "not found".
      throw new BadRequestException("That provider does not use the browser sign-in flow");
    }
    return raw;
  }

  /** Opens the provider's consent screen.
   *
   * The app opens this in a browser rather than calling it, so there is
   * nothing to return -- it is a redirect, and the app never sees the
   * provider's authorization code at all. See OauthFlowService.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get("social/:provider/start")
  socialStart(
    @Param("provider") providerParam: string,
    @Query("locale") locale: string | undefined,
    @Res() res: Response,
  ) {
    const provider = this.browserProvider(providerParam);
    try {
      res.redirect(this.oauthFlow.start(provider, locale ?? "en"));
    } catch {
      // Almost always a provider with no credentials configured. Letting
      // the exception through would render Nest's JSON error page inside
      // the sign-in browser, and the customer's only way out is to
      // dismiss it -- which the app reads as a cancellation and reports
      // as nothing at all. So the button would appear to do nothing.
      // Bouncing straight back to the app turns that into a message.
      res.redirect(this.oauthFlow.appCallback({ error: "unavailable" }));
    }
  }

  /** Where the provider sends the browser back.
   *
   * Everything that can go wrong here -- a declined consent screen, an
   * expired state, a provider that will not exchange the code -- ends
   * the same way: back at the app with an `error`, so the app closes
   * the browser and says something, rather than leaving the customer
   * staring at a blank page wondering whether it worked.
   */
  @Get("social/:provider/callback")
  async socialCallback(
    @Param("provider") providerParam: string,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") providerError: string | undefined,
    @Res() res: Response,
  ) {
    const provider = this.browserProvider(providerParam);

    // The customer pressed Cancel on the consent screen. Not an error
    // to report, just a flow that ended.
    if (providerError) {
      res.redirect(this.oauthFlow.appCallback({ error: "cancelled" }));
      return;
    }
    if (!code || !state) {
      res.redirect(this.oauthFlow.appCallback({ error: "invalid" }));
      return;
    }

    try {
      const pending = this.oauthFlow.consumeState(state);
      // The state carries which provider started the flow, so a
      // callback aimed at /google/callback cannot replay a state minted
      // for Facebook.
      if (pending.provider !== provider) throw new BadRequestException("provider mismatch");

      const providerToken = await this.oauthFlow.exchangeCode(provider, code);
      const upper = provider.toUpperCase() as "GOOGLE" | "FACEBOOK";
      const identity = await this.socialAuth.verify(upper, providerToken);
      const { customer, created } = await this.socialAuth.resolveCustomer(upper, identity, pending.locale);
      if (created) await this.customerAuthService.onSocialSignup(customer.id);
      const tokens = await this.customerAuthService.issueTokenPair(customer);
      res.redirect(this.oauthFlow.appCallback({ handoff: this.oauthFlow.storeHandoff(tokens) }));
    } catch (err) {
      // resolveCustomer refuses for reasons the customer can act on --
      // a disabled account, an unverified password account with the
      // same address, a provider account with no email. Those messages
      // are written for them, so they travel; anything else does not,
      // because an internal failure reads as an accusation.
      const message =
        err instanceof BadRequestException || err instanceof UnauthorizedException
          ? (err.getResponse() as { message?: string }).message
          : undefined;
      res.redirect(
        this.oauthFlow.appCallback(
          typeof message === "string" && message !== "provider mismatch"
            ? { error: "rejected", detail: message }
            : { error: "failed" },
        ),
      );
    }
  }

  /** Trades the one-time code from the redirect for the session.
   *
   * Separate from the redirect because a refresh token must not travel
   * in a URL: custom-scheme URLs are handled by whatever claims the
   * scheme and land in browser history on the way.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("social/exchange")
  @HttpCode(HttpStatus.OK)
  socialExchange(@Body() dto: SocialExchangeDto) {
    return this.oauthFlow.consumeHandoff(dto.code);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Ip() ip: string, @Headers() headers: HeaderBag) {
    this.loginGuard.enforce("customer", dto.challenge, dto.email, ip);
    try {
      // The device's own name for itself (X-Neoxify-Device-Label/-Platform),
      // shown to the customer's other devices by device slots.
      const result = await this.customerAuthService.login(dto.email, dto.password, deviceInfoFrom(headers));
      this.loginGuard.recordSuccess("customer", dto.email);
      return result;
    } catch (err) {
      this.loginGuard.recordFailure("customer", dto.email, ip);
      throw err;
    }
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto, @Headers() headers: HeaderBag) {
    return this.customerAuthService.refresh(dto.refreshToken, deviceInfoFrom(headers));
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(CustomerJwtAuthGuard)
  async logout(@CurrentCustomer() customer: AuthenticatedCustomer) {
    // This device only. It used to revoke every session the customer
    // had, so signing out on one device signed out all of them -- and,
    // with clients that end a rejected session, dropped their tunnels.
    await this.customerAuthService.revokeSession(customer.sub, customer.sid);
  }

  /** Changes the password of a signed-in customer, and hands back fresh
   * tokens because the change revokes the caller's own session too.
   *
   * Throttled like the other password paths: being authenticated doesn't
   * make this a good place to let someone guess the current password.
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("change-password")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(CustomerJwtAuthGuard)
  changePassword(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: ChangePasswordDto) {
    return this.customerAuthService.changePassword(customer.sub, dto, customer.sid);
  }

  // No guard -- the token itself is the credential (mirrors admin MFA's
  // mfaToken exchange). This is the actual gate for login/VPN access: no
  // session or trial/paid credentials exist for a customer until either
  // this or verify-email-code succeeds.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.customerAuthService.verifyEmail(dto.token);
  }

  /** The page the email's button actually points at.
   *
   * The button used to link straight to `neoconnect://verify-email?...`.
   * Webmail strips custom URI schemes, so in Gmail and Yahoo it wasn't
   * clickable at all -- reported by a real user on a real account. An
   * https:// link survives every client, so the link comes here and this
   * does the work.
   *
   * Verifies before rendering, so the link works from a phone or a
   * machine without the app; opening the app is then offered as a
   * convenience rather than being the mechanism. Returns HTML rather
   * than redirecting straight to the deep link, because a redirect to an
   * unhandled scheme shows a browser error page and looks broken to
   * someone who simply hasn't installed the app yet.
   *
   * GET, because mail clients and link scanners issue GETs -- which does
   * mean a scanner can consume the link before the customer clicks it.
   * That's tolerable here: the outcome is a verified account, which is
   * what they asked for, and the same throttle applies.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get("verify-email/open")
  @Header("Content-Type", "text/html; charset=utf-8")
  async verifyEmailLanding(@Query("token") token: string): Promise<string> {
    const deepLink = `neoconnect://verify-email?token=${encodeURIComponent(token ?? "")}`;
    if (!token) {
      return verificationFailedPage("That link is missing its verification token.");
    }
    try {
      const result = await this.customerAuthService.verifyEmail(token);
      return verifiedPage(deepLink, result.alreadyVerified);
    } catch (err) {
      const message = err instanceof BadRequestException ? err.message : "Something went wrong verifying this link.";
      return verificationFailedPage(message);
    }
  }

  // The short-code alternative to the link/token above -- see
  // CustomerAuthService.sendVerificationEmail()'s doc comment for why
  // both exist. Also unauthenticated: an unverified account has no
  // session to authenticate this call with in the first place.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("verify-email-code")
  @HttpCode(HttpStatus.OK)
  verifyEmailCode(@Body() dto: VerifyEmailCodeDto) {
    return this.customerAuthService.verifyEmailByCode(dto.email, dto.code);
  }

  // Unauthenticated (see CustomerAuthService.resendVerification()'s doc
  // comment) and always 204 regardless of whether the email exists or is
  // already verified -- same no-enumeration shape as forgot-password.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("resend-verification")
  @HttpCode(HttpStatus.NO_CONTENT)
  async resendVerification(@Body() dto: ResendVerificationDto) {
    await this.customerAuthService.resendVerification(dto.email);
  }

  // Always returns 204 regardless of whether the email exists -- see
  // CustomerAuthService.forgotPassword()'s doc comment on why.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("forgot-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.customerAuthService.forgotPassword(dto.email);
  }

  /** Reset by emailed token.
   *
   * Correct and tested, but currently unreachable: forgotPassword() no
   * longer issues a token, because the only way to deliver one is a link
   * and nothing can receive it -- see its comment. Kept for the website,
   * which is the surface a link makes sense for. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("reset-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.customerAuthService.resetPassword(dto.token, dto.newPassword);
  }

  /** Reset by the emailed code rather than the emailed link.
   *
   * This is the one the desktop app uses: it is where a locked-out
   * customer already is, and it needs no link to survive a mail client.
   *
   * Throttled harder than the token route. Six digits is a small space,
   * and unlike the token there is no signature to forge -- the limit is
   * what keeps guessing impractical, so it is part of the design rather
   * than boilerplate.
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("reset-password-code")
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPasswordByCode(@Body() dto: ResetPasswordCodeDto) {
    await this.customerAuthService.resetPasswordByCode(dto.email, dto.code, dto.newPassword);
  }
}
