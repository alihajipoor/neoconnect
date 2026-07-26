import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { randomInt } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { CustomersService } from "../customers/customers.service";
import { CreateCustomerDto } from "../customers/dto/create-customer.dto";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { FreeTrialSettingsService } from "../free-trial-settings/free-trial-settings.service";
import { EmailService } from "../email/email.service";
import { verificationEmail, passwordResetEmail } from "../email/templates";
import { ChangePasswordDto } from "./dto/change-password.dto";
import {
  CustomerAccessTokenPayload,
  CustomerRefreshTokenPayload,
  CustomerVerifyEmailTokenPayload,
  CustomerPasswordResetTokenPayload,
  CustomerRequiresVerification,
} from "./types";

export interface CustomerTokenPair {
  accessToken: string;
  refreshToken: string;
}

const VERIFY_EMAIL_TOKEN_TTL = "24h";
const VERIFY_EMAIL_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL = "30m";

@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly customersService: CustomersService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly protocolUsersService: ProtocolUsersService,
    private readonly freeTrialSettingsService: FreeTrialSettingsService,
    private readonly emailService: EmailService,
  ) {}

  /** Creates the Customer via the same service/logic the admin-facing
   * CustomersService.create() already uses (argon2 hash, referralCode,
   * duplicate-email ConflictException) -- no separate signup logic to
   * keep in sync. Deliberately does NOT issue a usable session or grant a
   * free trial here: per the 2026-07-24 decision, an account can't log
   * in -- not just can't get VPN access -- until it verifies its email.
   * Returns the same `requiresVerification` shape login() does for an
   * unverified account, so the app has one response shape to branch on
   * regardless of which endpoint got it there. */
  async register(dto: CreateCustomerDto): Promise<CustomerRequiresVerification> {
    const customer = await this.customersService.create(dto);

    // One email, not two. The welcome used to be its own send whose
    // entire content was "a separate verification email is on its way" --
    // nothing actionable, arriving before the customer could do anything,
    // and doubling how much of our mail a spam filter got to judge.
    await this.sendVerificationEmail(customer.id, customer.email);

    return { requiresVerification: true, email: customer.email };
  }

  /** Sends both a deep-link token (for "Open in Neoxify") and a short
   * 6-digit code (for typing directly into the app) -- added 2026-07-24
   * after live testing showed the raw JWT is unusable to hand-type and
   * broke the email's layout when displayed prominently. The code is
   * looked up server-side (verifyEmailByCode()), unlike the token which
   * is self-verifying, so it has to be persisted with its own expiry. */
  private async sendVerificationEmail(customerId: string, email: string) {
    const payload: CustomerVerifyEmailTokenPayload = { sub: customerId, purpose: "verify-email" };
    const token = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>("customerJwt.accessSecret"),
      expiresIn: VERIFY_EMAIL_TOKEN_TTL,
    });

    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        emailVerificationCode: code,
        emailVerificationCodeExpiresAt: new Date(Date.now() + VERIFY_EMAIL_CODE_TTL_MS),
      },
    });

    await this.emailService.sendMail({
      to: email,
      ...verificationEmail(token, code, this.config.get<string>("publicApiUrl")),
    });
  }

  /** Re-sends the verification email/code by email address -- NOT
   * authenticated, unlike the original design. That guard stopped making
   * sense once register()/login() stopped issuing a session for
   * unverified accounts (2026-07-24): the app has no token to authenticate
   * with at exactly the point it needs this. Same no-enumeration shape as
   * forgotPassword() -- always resolves the same way regardless of
   * whether the email exists or is already verified, only actually sends
   * when there's a real, unverified account to send it to. */
  async resendVerification(email: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer || customer.emailVerifiedAt) return;
    await this.sendVerificationEmail(customer.id, customer.email);
  }

  /** The gate for all VPN access, trial or paid (2026-07-24 decision):
   * marks the account verified, then -- only now -- grants a free trial
   * if trial mode is enabled. Idempotent: verifying an already-verified
   * account just confirms it's verified without granting a second trial. */
  async verifyEmail(token: string) {
    let payload: CustomerVerifyEmailTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<CustomerVerifyEmailTokenPayload>(token, {
        secret: this.config.get<string>("customerJwt.accessSecret"),
      });
    } catch {
      throw new BadRequestException("Invalid or expired verification link");
    }
    if (payload.purpose !== "verify-email") {
      throw new BadRequestException("Invalid or expired verification link");
    }

    const customer = await this.prisma.customer.findUnique({ where: { id: payload.sub } });
    if (!customer) {
      throw new BadRequestException("Invalid or expired verification link");
    }
    return this.completeVerification(customer.id, customer.emailVerifiedAt);
  }

  /** Alternative to the token/link above -- the short code an app can
   * offer a plain text input for, since a raw JWT is unusable to
   * hand-type and unreliable to click from many email clients (custom
   * `neoconnect://` links get stripped by some webmail sanitizers). Looks
   * the code up by email (not customerId, since the app doesn't have one
   * yet at this point) and checks it hasn't expired. */
  async verifyEmailByCode(email: string, code: string) {
    const customer = await this.prisma.customer.findUnique({ where: { email } });

    // Already-verified is checked before the code, because verifying
    // clears the code. Someone who clicked the emailed link on their
    // phone and then typed the code into the app was told the code had
    // expired -- while their account was in fact verified and fine. The
    // account is what matters, not which route confirmed it, and saying
    // "expired" sent people off to request codes that would never help.
    if (customer?.emailVerifiedAt) {
      return { alreadyVerified: true, trial: null };
    }

    if (
      !customer ||
      !customer.emailVerificationCode ||
      customer.emailVerificationCode !== code ||
      !customer.emailVerificationCodeExpiresAt ||
      customer.emailVerificationCodeExpiresAt < new Date()
    ) {
      throw new BadRequestException("Invalid or expired verification code");
    }
    return this.completeVerification(customer.id, customer.emailVerifiedAt);
  }

  private async completeVerification(customerId: string, alreadyVerifiedAt: Date | null) {
    if (alreadyVerifiedAt) {
      return { alreadyVerified: true, trial: null };
    }

    await this.prisma.customer.update({
      where: { id: customerId },
      data: { emailVerifiedAt: new Date(), emailVerificationCode: null, emailVerificationCodeExpiresAt: null },
    });
    const trial = await this.grantFreeTrialIfEnabled(customerId);
    return { alreadyVerified: false, trial };
  }

  private async grantFreeTrialIfEnabled(customerId: string) {
    const settings = await this.freeTrialSettingsService.get();
    if (!settings.enabled || !settings.trialPlanId || !settings.trialRouteId) {
      return null;
    }

    const subscription = await this.subscriptionsService.create({
      customerId,
      planId: settings.trialPlanId,
    });
    const protocolUser = await this.protocolUsersService.create({
      subscriptionId: subscription.id,
      routeId: settings.trialRouteId,
    });

    return { subscription, protocolUser };
  }

  async validateCredentials(email: string, password: string) {
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer) {
      throw new UnauthorizedException("Invalid email or password");
    }
    const valid = await argon2.verify(customer.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException("Invalid email or password");
    }
    if (customer.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is disabled");
    }
    return customer;
  }

  /** Blocks unverified accounts from ever getting a usable session
   * (2026-07-24 decision) -- returns the same `requiresVerification`
   * shape register() does rather than a token pair, mirroring the admin
   * side's `{mfaRequired: true, mfaToken}` pattern in AuthService.login().
   * A stale already-issued token from before this change still works
   * until it naturally expires; this only gates new logins. */
  async login(email: string, password: string): Promise<CustomerTokenPair | CustomerRequiresVerification> {
    const customer = await this.validateCredentials(email, password);
    if (!customer.emailVerifiedAt) {
      return { requiresVerification: true, email: customer.email };
    }
    return this.issueTokenPair(customer);
  }

  async issueTokenPair(customer: { id: string; email: string; tokenVersion: number }): Promise<CustomerTokenPair> {
    const accessPayload: CustomerAccessTokenPayload = { sub: customer.id, email: customer.email };
    const refreshPayload: CustomerRefreshTokenPayload = { sub: customer.id, tokenVersion: customer.tokenVersion };

    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.get<string>("customerJwt.accessSecret"),
      expiresIn: this.config.get<string>("customerJwt.accessTtl"),
    });
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.get<string>("customerJwt.refreshSecret"),
      expiresIn: this.config.get<string>("customerJwt.refreshTtl"),
    });

    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string): Promise<CustomerTokenPair> {
    let payload: CustomerRefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<CustomerRefreshTokenPayload>(refreshToken, {
        secret: this.config.get<string>("customerJwt.refreshSecret"),
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const customer = await this.prisma.customer.findUnique({ where: { id: payload.sub } });
    if (!customer || customer.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException("Refresh token has been revoked");
    }

    return this.issueTokenPair(customer);
  }

  /** Invalidates all outstanding refresh tokens for this customer. */
  async revokeAllSessions(customerId: string): Promise<void> {
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  /** Always resolves the same way regardless of whether the email exists
   * -- the controller returns one generic message either way, so this
   * can't be used to enumerate registered accounts. Only actually sends
   * an email when a matching, active customer is found. */
  async forgotPassword(email: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer || customer.status !== "ACTIVE") return;

    const payload: CustomerPasswordResetTokenPayload = { sub: customer.id, purpose: "password-reset" };
    const token = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>("customerJwt.accessSecret"),
      expiresIn: PASSWORD_RESET_TOKEN_TTL,
    });
    await this.emailService.sendMail({ to: customer.email, ...passwordResetEmail(token) });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    let payload: CustomerPasswordResetTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<CustomerPasswordResetTokenPayload>(token, {
        secret: this.config.get<string>("customerJwt.accessSecret"),
      });
    } catch {
      throw new BadRequestException("Invalid or expired reset link");
    }
    if (payload.purpose !== "password-reset") {
      throw new BadRequestException("Invalid or expired reset link");
    }

    const passwordHash = await argon2.hash(newPassword);
    // Bumping tokenVersion invalidates every outstanding refresh token --
    // a password reset should end any session an attacker (or the user
    // on another device) already had open.
    await this.prisma.customer.update({
      where: { id: payload.sub },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
  }

  /** Changes the password of an already-signed-in customer.
   *
   * Distinct from resetPassword above: that one proves identity with an
   * emailed token because the customer is locked out, this one proves it
   * with the current password because they aren't. Re-checking the
   * current password matters precisely because the caller is already
   * authenticated -- otherwise anyone who got hold of a session could
   * change the password and lock the real owner out permanently.
   *
   * Returns fresh tokens. Bumping tokenVersion revokes every session
   * including the caller's own, so without new ones the app would
   * silently log itself out on the very next request.
   */
  async changePassword(customerId: string, dto: ChangePasswordDto) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      throw new BadRequestException("Account not found");
    }

    const valid = await argon2.verify(customer.passwordHash, dto.currentPassword);
    if (!valid) {
      throw new BadRequestException("Your current password is incorrect");
    }

    const passwordHash = await argon2.hash(dto.newPassword);
    const updated = await this.prisma.customer.update({
      where: { id: customerId },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });

    return this.issueTokenPair(updated);
  }
}
