import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import { CustomersService } from "../customers/customers.service";
import { CreateCustomerDto } from "../customers/dto/create-customer.dto";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { FreeTrialSettingsService } from "../free-trial-settings/free-trial-settings.service";
import { EmailService } from "../email/email.service";
import { welcomeEmail, verificationEmail, passwordResetEmail } from "../email/templates";
import {
  CustomerAccessTokenPayload,
  CustomerRefreshTokenPayload,
  CustomerVerifyEmailTokenPayload,
  CustomerPasswordResetTokenPayload,
} from "./types";

export interface CustomerTokenPair {
  accessToken: string;
  refreshToken: string;
}

const VERIFY_EMAIL_TOKEN_TTL = "24h";
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
   * keep in sync. Deliberately does NOT grant a free trial here even if
   * trial mode is enabled: per the 2026-07-24 decision, no VPN access
   * (trial or paid) is granted until the customer verifies their email --
   * see verifyEmail() below, which is where grantFreeTrialIfEnabled()
   * actually runs. */
  async register(dto: CreateCustomerDto) {
    const customer = await this.customersService.create(dto);
    // Freshly created -- schema default is 0, no need to re-fetch.
    const tokens = await this.issueTokenPair({ id: customer.id, email: customer.email, tokenVersion: 0 });

    await this.emailService.sendMail({ to: customer.email, ...welcomeEmail() });
    await this.sendVerificationEmail(customer.id, customer.email);

    return { ...tokens, trial: null };
  }

  private async sendVerificationEmail(customerId: string, email: string) {
    const payload: CustomerVerifyEmailTokenPayload = { sub: customerId, purpose: "verify-email" };
    const token = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>("customerJwt.accessSecret"),
      expiresIn: VERIFY_EMAIL_TOKEN_TTL,
    });
    await this.emailService.sendMail({ to: email, ...verificationEmail(token) });
  }

  /** Re-sends the verification email for the calling (already
   * authenticated but unverified) customer -- e.g. the original email
   * was lost or its 24h token expired. */
  async resendVerification(customerId: string): Promise<void> {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    if (customer.emailVerifiedAt) {
      throw new BadRequestException("This email address is already verified");
    }
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
    if (customer.emailVerifiedAt) {
      return { alreadyVerified: true, trial: null };
    }

    await this.prisma.customer.update({ where: { id: customer.id }, data: { emailVerifiedAt: new Date() } });
    const trial = await this.grantFreeTrialIfEnabled(customer.id);
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

  async login(email: string, password: string): Promise<CustomerTokenPair> {
    const customer = await this.validateCredentials(email, password);
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
}
