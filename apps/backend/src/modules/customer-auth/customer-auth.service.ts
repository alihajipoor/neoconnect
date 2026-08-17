import { BadRequestException, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { randomInt } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { CustomersService } from "../customers/customers.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { FreeTrialSettingsService } from "../free-trial-settings/free-trial-settings.service";
import { EmailService } from "../email/email.service";
import { ReferralsService } from "../referrals/referrals.service";
import { RegisterCustomerDto } from "./dto/register-customer.dto";
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
// Thirty minutes, the same window the token flow used. Short because a
// reset code is a live credential sitting in an inbox.
const PASSWORD_RESET_CODE_TTL_MS = 30 * 60 * 1000;

/**
 * Wrong guesses at one account's reset code before the code is burned.
 *
 * Six digits is a million-value space, and the per-IP throttle is the
 * only other thing standing in front of it. Per-IP is exactly the limit
 * that a distributed attacker walks around: 5/minute from each of a
 * thousand addresses is 150,000 guesses inside the code's thirty-minute
 * life, which is a one-in-seven chance at a *chosen* account. Counting
 * the guesses against the ACCOUNT is the only measure that sees that
 * shape -- the same reasoning as LoginGuardService's account counters.
 *
 * Burning the code rather than locking the account is deliberate. A
 * lockout would hand anyone who knows an email address a way to deny
 * the owner their own reset; burning the code costs the real customer
 * one more "email me a code" press and costs the attacker their whole
 * window.
 */
const RESET_CODE_MAX_ATTEMPTS = 5;

@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);

  /**
   * Wrong reset-code guesses, keyed by lowercased email.
   *
   * Process-local, like LoginGuardService's counters, and for the same
   * reasons: it holds minutes of bookkeeping rather than records, and
   * there is one backend instance (infra/docker-compose.prod.yml). A
   * restart forgets the counter but NOT its effect -- burning a code is
   * a database write, so nothing an attacker already lost comes back.
   * Only ever written for an address that has a live code, so it cannot
   * be grown without bound by naming addresses that do not exist.
   */
  private readonly resetCodeAttempts = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly customersService: CustomersService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly protocolUsersService: ProtocolUsersService,
    private readonly freeTrialSettingsService: FreeTrialSettingsService,
    private readonly referralsService: ReferralsService,
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
  async register(dto: RegisterCustomerDto): Promise<CustomerRequiresVerification> {
    // Resolved before the account exists, so a wrong code fails the
    // signup outright instead of silently creating an account that
    // credits nobody. A typo here costs the inviter their reward and
    // neither party would ever find out.
    const referredByCustomerId = await this.referralsService.resolveReferralCode(dto.referralCode);

    const customer = await this.customersService.create(dto);
    if (referredByCustomerId) {
      await this.prisma.customer.update({
        where: { id: customer.id },
        data: { referredByCustomerId },
      });
    }

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
      // Retried here, because this is the path a customer whose grant
      // failed comes back through. grantFreeTrialIfEnabled refuses if
      // they already have a subscription, so an ordinary re-verification
      // still gets nothing.
      return { alreadyVerified: true, trial: await this.retryTrial(customer.id) };
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

  /** Best-effort second chance at a trial that failed its first. */
  private async retryTrial(customerId: string) {
    try {
      return await this.grantFreeTrialIfEnabled(customerId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Trial retry failed for customer ${customerId}: ${reason}`);
      return null;
    }
  }

  private async completeVerification(customerId: string, alreadyVerifiedAt: Date | null) {
    if (alreadyVerifiedAt) {
      return { alreadyVerified: true, trial: await this.retryTrial(customerId) };
    }

    await this.prisma.customer.update({
      where: { id: customerId },
      data: { emailVerifiedAt: new Date(), emailVerificationCode: null, emailVerificationCodeExpiresAt: null },
    });
    // Caught, not propagated. The account is already marked verified by
    // the update above, so letting this throw returns an error to
    // someone whose email *is* verified -- and leaves them unable to
    // sign in while the trial they cannot see is the reason. The grant
    // is retried on their next verify attempt or sign-in instead.
    let trial = null;
    try {
      trial = await this.grantFreeTrialIfEnabled(customerId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Trial grant failed for customer ${customerId}, will retry later: ${reason}`);
    }

    // Only now, not at signup. An unverified account is not a person
    // yet, and mailing on an unconfirmed address would turn a shared
    // referral link into a way to send mail to strangers. Best-effort
    // inside, so a notification cannot fail the verification.
    await this.referralsService.notifyReferrerOfActivation(customerId);

    return { alreadyVerified: false, trial };
  }

  private async grantFreeTrialIfEnabled(customerId: string) {
    // Never twice, and safe to call again after a failure. Keyed on the
    // customer having no subscription at all rather than on a flag,
    // because that is the actual question -- a trial is what somebody
    // gets when they have never had anything.
    //
    // This is what makes retrying possible. Before it, the grant ran
    // exactly once, wired to a verification that had already been
    // written down: if anything threw -- an inactive trial plan throws
    // from subscriptionsService.create, which is how this was found --
    // the customer was left verified with nothing, and every later
    // attempt took the already-verified path and returned null. One
    // failure cost them the trial permanently.
    const existing = await this.prisma.subscription.count({ where: { customerId } });
    if (existing > 0) return null;

    const settings = await this.freeTrialSettingsService.get();
    // Say which condition stopped it, rather than returning null in
    // silence. A customer who verifies and receives nothing is
    // indistinguishable, from every log this service writes, from a
    // customer who was never offered a trial at all -- which is exactly
    // the position info@neoxify.com left us in on 2026-08-17: verified,
    // zero subscriptions, and not one line anywhere saying why.
    //
    // Reported at warn because a verified signup getting no trial is a
    // lost customer, not routine bookkeeping.
    if (!settings.enabled || !settings.trialPlanId || !settings.trialRouteId) {
      const missing = [
        settings.enabled ? null : "trial mode is off",
        settings.trialPlanId ? null : "no trial plan is set",
        settings.trialRouteId ? null : "no trial route is set",
      ].filter(Boolean);
      this.logger.warn(`No trial granted to customer ${customerId}: ${missing.join("; ")}`);
      return null;
    }

    const subscription = await this.subscriptionsService.create({
      customerId,
      planId: settings.trialPlanId,
    });
    // Every route the trial plan allows, so a trial customer gets the
    // same failover the paid one does -- they are the likeliest to be on
    // a network that blocks something, and the likeliest to give up if
    // the first attempt fails.
    const { created: protocolUsers } = await this.protocolUsersService.provisionAll(subscription.id);

    // trialRouteId stays the preferred one, and stays first in the
    // response so an older client reading only the first entry still
    // gets the route the operator chose.
    protocolUsers.sort((a, b) =>
      a.routeId === settings.trialRouteId ? -1 : b.routeId === settings.trialRouteId ? 1 : 0,
    );

    return { subscription, protocolUsers, protocolUser: protocolUsers[0] ?? null };
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

    // A code, not a token. The email used to carry a signed JWT behind
    // an "enter this code" instruction, which is neither typeable nor
    // something any client here accepts -- the flow read as available
    // while being unusable.
    //
    // resetPassword() and its token still exist and are still correct;
    // nothing issues a token now, because the only place one could be
    // delivered is a link, and no surface can receive one. A website
    // would reinstate that path by signing a token here and linking to
    // its own reset page, the way verification's https bounce page
    // works. Until then this is the whole flow.
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await this.prisma.customer.update({
      where: { id: customer.id },
      data: {
        passwordResetCode: code,
        passwordResetCodeExpiresAt: new Date(Date.now() + PASSWORD_RESET_CODE_TTL_MS),
      },
    });
    // A new code gets a fresh budget. Without this a customer who ran
    // their guesses down would find the replacement burned on its first
    // wrong keystroke -- and an attacker gains nothing, since asking for
    // a new code invalidates the one they were guessing at.
    this.resetCodeAttempts.delete(this.resetCodeKey(customer.email));

    await this.emailService.sendMail({ to: customer.email, ...passwordResetEmail(code) });
  }

  /** Resets by emailed code rather than by token.
   *
   * The token route stays for anything that can receive a link; this is
   * the one a desktop client can use, and mirrors verifyEmailByCode.
   *
   * The email address is part of the credential here, unlike the token
   * which identifies the account by itself. Six digits alone would be a
   * million-guess space shared across every customer; tied to one
   * address, and rate-limited at the controller, it is the same strength
   * as the verification code already in use.
   */
  async resetPasswordByCode(email: string, code: string, newPassword: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({ where: { email } });

    const codeIsLive =
      !!customer &&
      customer.status === "ACTIVE" &&
      !!customer.passwordResetCode &&
      !!customer.passwordResetCodeExpiresAt &&
      customer.passwordResetCodeExpiresAt >= new Date();

    if (!customer || !codeIsLive || customer.passwordResetCode !== code) {
      // Count the miss against the account, and burn the code once the
      // guesses run out -- see RESET_CODE_MAX_ATTEMPTS. Only when a live
      // code exists: counting misses for addresses with no code running
      // would let anyone fill this map by naming strangers.
      if (customer && codeIsLive) {
        await this.recordResetCodeMiss(customer.id, email);
      }
      // Deliberately identical whatever went wrong -- a distinct "no such
      // account" would turn this into an account-enumeration oracle, which
      // is the very thing forgotPassword() goes to lengths to avoid. The
      // burn is silent for the same reason: an attacker must not be able
      // to tell "wrong code" from "wrong code, and that was your last".
      throw new BadRequestException("Invalid or expired reset code");
    }

    this.resetCodeAttempts.delete(this.resetCodeKey(email));
    await this.applyNewPassword(customer.id, newPassword);
  }

  private resetCodeKey(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Tally a wrong guess, and clear the code when the budget is spent. */
  private async recordResetCodeMiss(customerId: string, email: string): Promise<void> {
    const key = this.resetCodeKey(email);
    const attempts = (this.resetCodeAttempts.get(key) ?? 0) + 1;

    if (attempts < RESET_CODE_MAX_ATTEMPTS) {
      this.resetCodeAttempts.set(key, attempts);
      return;
    }

    this.resetCodeAttempts.delete(key);
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { passwordResetCode: null, passwordResetCodeExpiresAt: null },
    });
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

    await this.applyNewPassword(payload.sub, newPassword);
  }

  /** The part both reset routes share.
   *
   * Bumping tokenVersion invalidates every outstanding refresh token --
   * a password reset should end any session an attacker (or the user on
   * another device) already had open. Clearing the code matters just as
   * much: a used code that still works is a second key left under the
   * mat for thirty minutes.
   */
  private async applyNewPassword(customerId: string, newPassword: string): Promise<void> {
    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        passwordHash,
        tokenVersion: { increment: 1 },
        passwordResetCode: null,
        passwordResetCodeExpiresAt: null,
      },
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
