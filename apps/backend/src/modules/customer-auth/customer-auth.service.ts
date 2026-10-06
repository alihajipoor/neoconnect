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
import { verificationEmail, passwordResetEmail, toLocale, type Locale } from "../email/templates";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { SESSION_IDLE_LIFETIME_MS } from "./session-lifetime";
import { hasDeviceInfo, type DeviceInfo } from "../../common/device-info";
import { DeviceSlotsService } from "../device-slots/device-slots.service";
import { KeyedLock } from "../protocol-users/keyed-lock";
import { GuessBudget, guessKey } from "./guess-budget";
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
 * Guesses one account's emailed codes may take per window, across every
 * code issued in it -- see GuessBudget for why the allowance belongs to
 * the account and not to each code.
 *
 * Six digits is a million-value space and the per-IP throttle is the only
 * other thing in front of it, which a distributed attacker walks around:
 * 5/minute from each of a thousand addresses is 150,000 guesses in a
 * reset code's thirty-minute life. Ten an hour bounds a chosen account to
 * 240 guesses a day, about one chance in four thousand, from any number
 * of addresses. When the allowance runs out the live code is burned too,
 * and nothing is compared until the hour is up.
 *
 * Ten rather than five because a new code no longer brings new guesses:
 * a customer who fumbles one code and asks for another is drawing on the
 * same allowance.
 */
const CODE_GUESSES_PER_WINDOW = 10;
const CODE_GUESS_WINDOW_MS = 60 * 60 * 1000;

/** The session columns a device's own description sets -- only those it
 * actually sent, so a request without the headers never erases a name. */
function deviceColumns(device: DeviceInfo | undefined): { label?: string; platform?: string } {
  if (!device || !hasDeviceInfo(device)) return {};
  return {
    ...(device.label !== null ? { label: device.label } : {}),
    ...(device.platform !== null ? { platform: device.platform } : {}),
  };
}

@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);

  /** Guesses at password-reset codes, per account. */
  private readonly resetCodeBudget = new GuessBudget(CODE_GUESSES_PER_WINDOW, CODE_GUESS_WINDOW_MS);
  /** Guesses at email-verification codes, per account. Its own allowance:
   * a verification code lives a day, and before this it had no account
   * limit at all -- a squatter who registered someone's address could
   * guess the code from enough addresses, and once "verified" the account
   * would later swallow the real owner's Google or Apple sign-in. */
  private readonly verifyCodeBudget = new GuessBudget(CODE_GUESSES_PER_WINDOW, CODE_GUESS_WINDOW_MS);

  /** Serialises trial grants per customer; see grantFreeTrialIfEnabled. */
  private readonly trialLock = new KeyedLock();

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
    private readonly deviceSlots: DeviceSlotsService,
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
    // Both of the things only a self-signing-up customer can tell us, in
    // the one write. The locale has to land before the send below, not
    // after: the verification email is the first thing this account ever
    // receives, and it is the one email whose whole purpose is to get
    // somebody to act on it.
    if (referredByCustomerId || dto.locale) {
      await this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          ...(referredByCustomerId ? { referredByCustomerId } : {}),
          ...(dto.locale ? { locale: dto.locale } : {}),
        },
      });
    }

    // One email, not two. The welcome used to be its own send whose
    // entire content was "a separate verification email is on its way" --
    // nothing actionable, arriving before the customer could do anything,
    // and doubling how much of our mail a spam filter got to judge.
    await this.sendVerificationEmail(customer.id, customer.email, toLocale(dto.locale));

    return { requiresVerification: true, email: customer.email };
  }

  /** Sends both a deep-link token (for "Open in Neoxify") and a short
   * 6-digit code (for typing directly into the app) -- added 2026-07-24
   * after live testing showed the raw JWT is unusable to hand-type and
   * broke the email's layout when displayed prominently. The code is
   * looked up server-side (verifyEmailByCode()), unlike the token which
   * is self-verifying, so it has to be persisted with its own expiry. */
  private async sendVerificationEmail(customerId: string, email: string, locale: Locale) {
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
      ...verificationEmail(locale, token, code, this.config.get<string>("publicApiUrl")),
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
    await this.sendVerificationEmail(customer.id, customer.email, toLocale(customer.locale));
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
    const refuse = () => new BadRequestException("Invalid or expired verification code");
    // Taken before anything is awaited -- see GuessBudget. Given back
    // below wherever the request turns out not to be a guess at a code.
    const key = guessKey(email);
    if (!this.verifyCodeBudget.take(key)) throw refuse();

    const customer = await this.prisma.customer.findUnique({ where: { email } });

    // Already-verified is checked before the code, because verifying
    // clears the code. Someone who clicked the emailed link on their
    // phone and then typed the code into the app was told the code had
    // expired -- while their account was in fact verified and fine. The
    // account is what matters, not which route confirmed it, and saying
    // "expired" sent people off to request codes that would never help.
    if (customer?.emailVerifiedAt) {
      // Nothing is granted here, and nothing is returned but the fact.
      // This branch is reached before the code is compared -- it has to
      // be, verifying clears the code -- so the caller has proven nothing:
      // it is anyone at all who knows a verified address. It used to retry
      // the trial grant, which let a stranger create a trial on somebody
      // else's account (every Google or Apple sign-up has no subscription)
      // and walk away with its decrypted credentials and node addresses.
      // A failed grant is retried at sign-in now (login), behind the
      // password.
      this.verifyCodeBudget.refund(key);
      return { alreadyVerified: true, trial: null };
    }

    const now = new Date();
    if (
      !customer ||
      !customer.emailVerificationCode ||
      !customer.emailVerificationCodeExpiresAt ||
      customer.emailVerificationCodeExpiresAt < now
    ) {
      this.verifyCodeBudget.refund(key);
      throw refuse();
    }
    if (customer.emailVerificationCode !== code) {
      // Out of guesses: the live code goes as well (resend issues a new
      // one, but no new guesses -- see GuessBudget).
      if (this.verifyCodeBudget.spent(key)) {
        await this.prisma.customer.update({
          where: { id: customer.id },
          data: { emailVerificationCode: null, emailVerificationCodeExpiresAt: null },
        });
      }
      throw refuse();
    }

    // Marked verified only if the code is still the one compared, in one
    // conditional write. A request that lost a race to another correct one
    // finds the account verified; one that lost it to a burn is refused.
    const { count } = await this.prisma.customer.updateMany({
      where: {
        id: customer.id,
        emailVerifiedAt: null,
        emailVerificationCode: code,
        emailVerificationCodeExpiresAt: { gte: now },
      },
      data: { emailVerifiedAt: now, emailVerificationCode: null, emailVerificationCodeExpiresAt: null },
    });
    this.verifyCodeBudget.clear(key);
    if (count === 0) {
      const after = await this.prisma.customer.findUnique({ where: { id: customer.id }, select: { emailVerifiedAt: true } });
      if (after?.emailVerifiedAt) return { alreadyVerified: true, trial: null };
      throw refuse();
    }
    return this.afterFirstVerification(customer.id);
  }

  /** Best-effort second chance at a trial that failed its first.
   * `quiet` drops the "no trial granted" warning, for sign-in: it runs on
   * every sign-in of a customer with no subscription, and a warning each
   * time trial mode is off would bury the one at verification that
   * matters. */
  private async retryTrial(customerId: string, quiet = false) {
    try {
      return await this.grantFreeTrialIfEnabled(customerId, quiet);
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
    return this.afterFirstVerification(customerId);
  }

  /** A new account made by a Google, Apple or Facebook sign-in.
   *
   * It is created already verified -- the provider proved the address --
   * so it never passes through verification, which is where a password
   * sign-up is granted its trial. With trial mode on, every Google or
   * Apple sign-up landed on "choose a plan" while a password sign-up got
   * the trial, and no log line said why. Never throws: the sign-in goes
   * ahead whatever happens to the trial. */
  async onSocialSignup(customerId: string): Promise<void> {
    await this.afterFirstVerification(customerId);
  }

  /** What follows an account being verified for the first time, by any
   * route: the trial, and the referrer told. */
  private async afterFirstVerification(customerId: string) {
    // Caught, not propagated. The account is already marked verified by
    // the update above, so letting this throw returns an error to
    // someone whose email *is* verified -- and leaves them unable to
    // sign in while the trial they cannot see is the reason. The grant
    // is retried at their next password sign-in (login) instead, or by
    // the emailed link, which proves the mailbox -- never by the code
    // route's already-verified branch, which proves nothing.
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

  /** One customer's grant at a time: the "no subscription yet" check and
   * the create are two statements, and two requests racing between them
   * (a double-tapped verify, a verify and a sign-in together) each made a
   * trial. */
  private grantFreeTrialIfEnabled(customerId: string, quiet = false) {
    return this.trialLock.run(customerId, () => this.grantFreeTrialUnlocked(customerId, quiet));
  }

  private async grantFreeTrialUnlocked(customerId: string, quiet: boolean) {
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

    // Never to an account an operator has switched off.
    const owner = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { status: true } });
    if (owner?.status !== "ACTIVE") return null;

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
      if (quiet) return null;
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
    // An account created through Google, Apple or Facebook has no
    // password. The message stays the generic one on purpose: telling an
    // unauthenticated caller "this address exists but signs in with
    // Google" hands them both a confirmed address and the provider to
    // phish. The customer sees the provider buttons on the same screen.
    if (customer.passwordHash === null) {
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
  async login(
    email: string,
    password: string,
    device?: DeviceInfo,
  ): Promise<CustomerTokenPair | CustomerRequiresVerification> {
    const customer = await this.validateCredentials(email, password);
    if (!customer.emailVerifiedAt) {
      return { requiresVerification: true, email: customer.email };
    }
    // The second chance at a trial whose grant failed at verification, or
    // that was never offered because trial mode was off then. Here because
    // this caller has proven the account is theirs; the app fetches the
    // credentials itself once signed in, so nothing is returned. A
    // customer who already has any subscription costs one count query.
    await this.retryTrial(customer.id, true);
    return this.issueTokenPair(customer, undefined, device);
  }

  /** Tokens for one signed-in device.
   *
   * `sessionId` continues an existing session (a refresh); without it a
   * new one is opened -- a sign-in -- named by `device` when the app said
   * what it is (see device-info.ts). See `CustomerSession` for why a
   * device has a session of its own. */
  async issueTokenPair(
    customer: { id: string; email: string; tokenVersion: number },
    sessionId?: string,
    device?: DeviceInfo,
  ): Promise<CustomerTokenPair> {
    const sid = sessionId ?? (await this.openSession(customer.id, device));
    const accessPayload: CustomerAccessTokenPayload = { sub: customer.id, email: customer.email, sid };
    const refreshPayload: CustomerRefreshTokenPayload = {
      sub: customer.id,
      tokenVersion: customer.tokenVersion,
      sid,
    };

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

  async refresh(refreshToken: string, device?: DeviceInfo): Promise<CustomerTokenPair> {
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
    // Disabling bumps tokenVersion too; this is the backstop for an
    // account disabled any other way. A disabled account kept refreshing
    // for as long as its app stayed open.
    if (customer.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is disabled");
    }

    // This device's own session, which signing out on this device -- and
    // only this device -- revokes. A token from before sessions existed
    // has none, and is moved onto a fresh one here, so that from its
    // first refresh it can be signed out without touching anyone else.
    if (typeof payload.sid === "string") {
      const live = await this.prisma.customerSession.updateMany({
        where: { id: payload.sid, customerId: customer.id, revokedAt: null },
        // The device's name rides along when the app sends it, so a
        // session opened where no headers could be sent (the browser
        // sign-in flow) is named by its first refresh. Never blanked by a
        // request that sent none.
        data: { lastUsedAt: new Date(), ...deviceColumns(device) },
      });
      if (live.count === 0) {
        throw new UnauthorizedException("Refresh token has been revoked");
      }
      return this.issueTokenPair(customer, payload.sid);
    }
    return this.issueTokenPair(customer, undefined, device);
  }

  /** Opens a session for a sign-in, and drops this customer's sessions
   * that can no longer be used -- signed out, or idle longer than a
   * refresh token lives -- so the table is bounded per customer without
   * a job of its own.
   *
   * Except those still holding device credentials. Those have to be
   * taken off the nodes first, which is the device-credential sweep's
   * job (ProtocolUsersService.sweepDeadSessionCredentials). Deleting the
   * row here instead would turn its credentials into shared ones (the
   * foreign key is SET NULL, for the sake of rollback) that sign-out
   * could then never reach. */
  private async openSession(customerId: string, device?: DeviceInfo): Promise<string> {
    const idleCutoff = new Date(Date.now() - SESSION_IDLE_LIFETIME_MS);
    await this.prisma.customerSession.deleteMany({
      where: {
        customerId,
        OR: [{ revokedAt: { not: null } }, { lastUsedAt: { lt: idleCutoff } }],
        protocolUsers: { none: {} },
      },
    });
    const session = await this.prisma.customerSession.create({
      data: { customerId, ...deviceColumns(device) },
      select: { id: true },
    });
    return session.id;
  }

  /** Signs out one device: the session its tokens carry. Every other
   * device keeps its session.
   *
   * A token from before sessions existed names none, and then nothing is
   * revoked server-side -- the device discards its own tokens, and other
   * devices are left alone, which is the point. Signing out used to call
   * `revokeAllSessions` here, ending every device the customer had.
   *
   * Then this device's own VPN credentials are taken off every node
   * (docs/per-device-credentials.md), and only this device's: the other
   * devices' credentials and the subscription's shared ones stay. The
   * session is revoked first, so even if the node commands fail the
   * session cannot mint a new set, and the hourly sweep retries them.
   * Failures are logged, never thrown -- a sign-out must not fail
   * because a node is down. */
  async revokeSession(customerId: string, sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    await this.prisma.customerSession.updateMany({
      where: { id: sessionId, customerId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    try {
      await this.protocolUsersService.revokeSessionCredentials(customerId, sessionId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Sign-out of session ${sessionId} could not revoke its credentials yet: ${reason}`);
    }
    // A signed-out device is not using the VPN: its slot goes to whoever
    // claims next, without asking. Never throws.
    await this.deviceSlots.releaseSession(customerId, sessionId);
  }

  /** Takes back the device credentials of sessions a password change has
   * already revoked (in the same transaction as the password), never
   * throwing: whatever this does not finish, the hourly sweep does,
   * because the sessions are already marked revoked. */
  private async endSessions(customerId: string, except?: string): Promise<void> {
    try {
      await this.protocolUsersService.endSessions(customerId, except);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Could not end sessions for customer ${customerId}: ${reason}`);
    }
    // And their device slots. Never throws.
    await this.deviceSlots.releaseOtherSessions(customerId, except);
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
    // A new code does NOT get a fresh allowance of guesses. It used to,
    // on the reasoning that asking for one retires the code being guessed
    // at -- but a fresh code is exactly as guessable, so an attacker asked
    // for one every five guesses and guessed at the uncapped rate. See
    // GuessBudget.

    await this.emailService.sendMail({
      to: customer.email,
      ...passwordResetEmail(toLocale(customer.locale), code),
    });
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
    // Every failure below says exactly this. A distinct "no such account"
    // would turn the route into the account-enumeration oracle
    // forgotPassword() goes to lengths to avoid, and a distinct "that was
    // your last guess" would tell an attacker when to stop.
    const refuse = () => new BadRequestException("Invalid or expired reset code");

    // Taken before anything is awaited, so a burst of parallel guesses
    // cannot all be compared before any of them is counted.
    const key = guessKey(email);
    if (!this.resetCodeBudget.take(key)) throw refuse();

    const customer = await this.prisma.customer.findUnique({ where: { email } });
    const now = new Date();
    const codeIsLive =
      !!customer &&
      customer.status === "ACTIVE" &&
      !!customer.passwordResetCode &&
      !!customer.passwordResetCodeExpiresAt &&
      customer.passwordResetCodeExpiresAt >= now;

    if (!customer || !codeIsLive) {
      // Not a guess at anything: no live code to compare with.
      this.resetCodeBudget.refund(key);
      throw refuse();
    }
    if (customer.passwordResetCode !== code) {
      // The allowance just ran out: the live code goes too, so it is not
      // waiting to be guessed the moment the window ends.
      if (this.resetCodeBudget.spent(key)) {
        await this.prisma.customer.update({
          where: { id: customer.id },
          data: { passwordResetCode: null, passwordResetCodeExpiresAt: null },
        });
      }
      throw refuse();
    }

    // Used up in one conditional write, so the code works once: a request
    // that read it before another used it, or before a burn, finds it
    // gone here rather than resetting the password a second time.
    const { count } = await this.prisma.customer.updateMany({
      where: { id: customer.id, passwordResetCode: code, passwordResetCodeExpiresAt: { gte: now } },
      data: { passwordResetCode: null, passwordResetCodeExpiresAt: null },
    });
    if (count === 0) throw refuse();

    this.resetCodeBudget.clear(key);
    await this.applyNewPassword(customer.id, newPassword);
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
    // The sessions are revoked in the same transaction as the password,
    // so the two succeed or fail together. They used to be revoked by the
    // best-effort endSessions below, whose first statement is that
    // revocation: a database error there was logged and swallowed, the
    // reset went through, and the devices it was meant to lock out kept
    // their sessions -- and, since the sweep only reclaims revoked or
    // idle sessions, their credentials, for as long as they kept using
    // them.
    await this.prisma.$transaction([
      this.prisma.customer.update({
        where: { id: customerId },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 },
          passwordResetCode: null,
          passwordResetCodeExpiresAt: null,
        },
      }),
      this.prisma.customerSession.updateMany({
        where: { customerId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    // tokenVersion stops the refresh tokens; this takes back the device
    // credentials those sessions were issued. The subscription's shared
    // credentials are NOT touched in phase 1: they stay valid on the
    // nodes, and anyone holding a copy keeps a working tunnel through the
    // reset. See docs/per-device-credentials.md, "Transition".
    await this.endSessions(customerId);
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
  async changePassword(customerId: string, dto: ChangePasswordDto, sessionId?: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      throw new BadRequestException("Account not found");
    }

    // Here the caller is already authenticated, so naming the situation
    // costs nothing and saying "your current password is incorrect" to
    // someone who has never had one is simply wrong.
    if (customer.passwordHash === null) {
      throw new BadRequestException(
        "This account signs in with Google, Apple or Facebook and has no password to change",
      );
    }

    const valid = await argon2.verify(customer.passwordHash, dto.currentPassword);
    if (!valid) {
      throw new BadRequestException("Your current password is incorrect");
    }

    const passwordHash = await argon2.hash(dto.newPassword);

    // The caller keeps its session, and with it the VPN credentials its
    // tunnel is running on; every other device is ended, credentials
    // and all. Opening a new session here instead -- what this did before
    // devices had credentials of their own -- would orphan the caller's
    // set and drop its tunnel on the next fetch.
    const keep =
      sessionId &&
      (
        await this.prisma.customerSession.updateMany({
          where: { id: sessionId, customerId, revokedAt: null },
          data: { lastUsedAt: new Date() },
        })
      ).count > 0
        ? sessionId
        : undefined;

    // The other sessions are revoked in the same transaction as the
    // password -- see applyNewPassword for why a swallowed failure there
    // was not good enough.
    const [updated] = await this.prisma.$transaction([
      this.prisma.customer.update({
        where: { id: customerId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      }),
      this.prisma.customerSession.updateMany({
        where: { customerId, revokedAt: null, ...(keep ? { id: { not: keep } } : {}) },
        data: { revokedAt: new Date() },
      }),
    ]);

    // Takes back the device credentials of the sessions just ended. As
    // with a reset, the subscription's shared credentials stay valid in
    // phase 1.
    await this.endSessions(customerId, keep);
    return this.issueTokenPair(updated, keep);
  }
}
