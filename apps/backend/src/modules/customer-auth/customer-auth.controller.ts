import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CustomerAuthService } from "./customer-auth.service";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { CurrentCustomer } from "../../common/decorators/current-customer.decorator";
import { AuthenticatedCustomer } from "./types";
import { CreateCustomerDto } from "../customers/dto/create-customer.dto";
import { LoginDto } from "../auth/dto/login.dto";
import { RefreshDto } from "../auth/dto/refresh.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { VerifyEmailCodeDto } from "./dto/verify-email-code.dto";
import { ResendVerificationDto } from "./dto/resend-verification.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { verificationFailedPage, verifiedPage } from "./verify-landing-page";
import { ResetPasswordDto } from "./dto/reset-password.dto";

// This is the API a future native client (Windows/macOS/Android/iOS)
// signs up and logs in through -- there is deliberately no web UI for
// any of this (see the "Customer Self-Signup + Free Trial Mode" plan
// section): the native clients are Phase 2 and don't exist yet, so this
// milestone is API-only, same precedent as Nodes/Routes before their
// panel UI existed (or, for Routes, still does).
@ApiTags("customer-auth")
@Controller("customer-auth")
export class CustomerAuthController {
  constructor(private readonly customerAuthService: CustomerAuthService) {}

  // Same brute-force reasoning as admin login. Registration no longer
  // grants a free trial directly (see CustomerAuthService.register()'s
  // doc comment) -- verify-email is the actual free-VPN-abuse gate now,
  // rate limiting here is just standard signup-endpoint hygiene.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register")
  @HttpCode(HttpStatus.OK)
  register(@Body() dto: CreateCustomerDto) {
    return this.customerAuthService.register(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login")
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.customerAuthService.login(dto.email, dto.password);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto) {
    return this.customerAuthService.refresh(dto.refreshToken);
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(CustomerJwtAuthGuard)
  async logout(@CurrentCustomer() customer: AuthenticatedCustomer) {
    await this.customerAuthService.revokeAllSessions(customer.sub);
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

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("reset-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.customerAuthService.resetPassword(dto.token, dto.newPassword);
  }
}
