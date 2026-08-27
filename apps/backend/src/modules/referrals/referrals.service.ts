import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InvoiceStatus, ReferralRewardReason, SubscriptionStatus } from "@prisma/client";
import { after, forEachBatch } from "../../common/batching";
import { PrismaService } from "../../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { referralFriendJoinedEmail, referralRewardEmail } from "../email/templates";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ReferralSettingsService } from "./referral-settings.service";

/** A "month" of paid subscription, for reward arithmetic.
 *
 * Thirty days rather than a calendar month, because subscriptions are
 * sold in days and nobody's plan starts on the first. It makes a
 * 31-day month worth slightly more than a plan month, which errs
 * towards the customer -- the right direction for a thank-you. */
const DAYS_PER_MONTH = 30;

/** Stops a runaway loop from granting an unbounded number of rewards in
 * one sweep. Reaching it means the arithmetic is wrong, so it logs. */
const MAX_REWARDS_PER_SWEEP = 20;

type FriendCredit = { customerId: string; available: number };

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: ReferralSettingsService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly protocolUsersService: ProtocolUsersService,
    private readonly emailService: EmailService,
  ) {}

  // -------------------------------------------------------------------
  // Signup
  // -------------------------------------------------------------------

  /** Resolves a referral code typed at signup to the customer who owns
   * it, ready to be stored on the new account.
   *
   * Returns `null` for "no code given". Throws for a code that was
   * given and is wrong: a typo that silently loses someone their
   * friend's reward is worse than one more field to correct, and the
   * person who suffers it would never find out.
   */
  async resolveReferralCode(code: string | undefined | null): Promise<string | null> {
    const trimmed = code?.trim();
    if (!trimmed) return null;

    const settings = await this.settingsService.get();
    if (!settings.enabled) {
      throw new BadRequestException("The referral programme is not currently running");
    }

    // Codes are generated lowercase hex, but a customer reading one off
    // a message will type it however it was written down.
    const referrer = await this.prisma.customer.findFirst({
      where: { referralCode: { equals: trimmed, mode: "insensitive" } },
      select: { id: true, status: true },
    });
    if (!referrer || referrer.status !== "ACTIVE") {
      throw new BadRequestException("That referral code is not valid");
    }
    return referrer.id;
  }

  /** Tells the inviter their invite worked.
   *
   * Called once the invited account is actually verified, not at
   * signup: an unverified account is not a person yet, and mailing on
   * an unconfirmed address would make the referral link a way to send
   * mail to strangers.
   *
   * Best-effort throughout -- a failed notification must never fail the
   * verification it is reporting on.
   */
  async notifyReferrerOfActivation(newCustomerId: string): Promise<void> {
    try {
      const customer = await this.prisma.customer.findUnique({
        where: { id: newCustomerId },
        select: { email: true, referredByCustomerId: true },
      });
      if (!customer?.referredByCustomerId) return;

      const referrer = await this.prisma.customer.findUnique({
        where: { id: customer.referredByCustomerId },
        select: { email: true },
      });
      if (!referrer) return;

      const progress = await this.progressFor(customer.referredByCustomerId);
      const mail = referralFriendJoinedEmail(maskEmail(customer.email), progress.monthsToNextReward);
      await this.emailService.sendMail({ to: referrer.email, ...mail });
    } catch (error) {
      this.logger.warn(`could not notify referrer of an activation: ${String(error)}`);
    }
  }

  // -------------------------------------------------------------------
  // The customer's own view
  // -------------------------------------------------------------------

  /** Everything the app's Referrals screen shows.
   *
   * Friends are listed by masked email. The inviter is entitled to know
   * their invite worked and whether that person is a paying customer;
   * they are not entitled to a readable copy of someone else's address,
   * and a link shared publicly would otherwise be a way to harvest
   * them.
   */
  async overviewFor(customerId: string) {
    const [settings, customer] = await Promise.all([
      this.settingsService.get(),
      this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { referralCode: true },
      }),
    ]);

    const friends = await this.prisma.customer.findMany({
      where: { referredByCustomerId: customerId },
      select: { id: true, email: true, createdAt: true, emailVerifiedAt: true },
      orderBy: { createdAt: "desc" },
    });

    const paidMonths = await this.paidMonthsByCustomer(friends.map((f) => f.id));
    const rewards = await this.prisma.referralReward.findMany({
      where: { referrerId: customerId },
      select: { id: true, reason: true, rewardDays: true, grantedAt: true },
      orderBy: { grantedAt: "desc" },
    });

    const progress = await this.progressFor(customerId);

    return {
      enabled: settings.enabled,
      code: customer?.referralCode ?? null,
      rules: {
        loyalFriendMonths: settings.loyalFriendMonths,
        friendsRequired: settings.friendsRequired,
        friendMonths: settings.friendMonths,
        rewardDays: settings.rewardDays,
      },
      friends: friends.map((friend) => ({
        maskedEmail: maskEmail(friend.email),
        joinedAt: friend.createdAt,
        // "Active" means they went on to pay for something, which is
        // what actually moves the inviter towards a reward. Showing
        // them as active merely for existing would make the progress
        // bar look wrong rather than generous.
        activated: friend.emailVerifiedAt !== null,
        paidMonths: paidMonths.get(friend.id) ?? 0,
      })),
      rewards,
      progress,
    };
  }

  /** How close this customer is to their next free month, by whichever
   * of the two routes is nearer. */
  private async progressFor(customerId: string) {
    const settings = await this.settingsService.get();
    const credits = await this.availableCredits(customerId);

    const best = credits.reduce((max, c) => Math.max(max, c.available), 0);
    const viaLoyalFriend = Math.max(0, settings.loyalFriendMonths - best);

    const qualifying = credits.filter((c) => c.available >= settings.friendMonths).length;
    // Each missing friend needs `friendMonths` of paid time, so the
    // distance is expressed in months for both routes rather than
    // "friends" for one and "months" for the other -- otherwise the two
    // numbers cannot be compared and the smaller one shown.
    const viaSeveralFriends =
      Math.max(0, settings.friendsRequired - qualifying) * settings.friendMonths;

    return {
      monthsToNextReward: Math.min(viaLoyalFriend, viaSeveralFriends),
      qualifyingFriends: qualifying,
      bestFriendMonths: best,
    };
  }

  // -------------------------------------------------------------------
  // Reward evaluation
  // -------------------------------------------------------------------

  /** Grants every reward that has been earned since the last run.
   *
   * Idempotent by construction: earning a reward *spends* the months
   * that paid for it (see ReferralCredit), so the same paid time can
   * never be counted twice however often this runs.
   */
  async sweep(): Promise<number> {
    const settings = await this.settingsService.get();
    if (!settings.enabled) return 0;
    if (!settings.rewardPlanId) {
      // Referrals still accumulate; there is simply nothing to grant
      // them on yet. Silent rather than logged every interval.
      return 0;
    }

    let granted = 0;
    // Not self-draining: a referrer is still an ACTIVE customer with
    // referrals after their rewards have been granted, so this needs a
    // real cursor to make progress rather than a drain loop.
    await forEachBatch({
      label: "referralSweep",
      read: (afterId, take) =>
        this.prisma.customer.findMany({
          where: { referrals: { some: {} }, status: "ACTIVE", ...after(afterId) },
          select: { id: true },
          orderBy: { id: "asc" },
          take,
        }),
      handle: async (batch) => {
        for (const referrer of batch) {
          granted += await this.sweepOne(referrer.id, settings);
        }
      },
    });
    return granted;
  }

  private async sweepOne(
    referrerId: string,
    settings: Awaited<ReturnType<ReferralSettingsService["get"]>>,
  ): Promise<number> {
    let granted = 0;

    for (let pass = 0; pass < MAX_REWARDS_PER_SWEEP; pass += 1) {
      const credits = await this.availableCredits(referrerId);

      // The loyal-friend rule first, then the several-friends rule.
      // Both are re-checked every pass and the loop only stops when
      // neither fires, so the order affects which months are spent
      // first but never whether a reward is missed.
      const loyal = credits.find((c) => c.available >= settings.loyalFriendMonths);
      if (loyal) {
        await this.grant(referrerId, ReferralRewardReason.LOYAL_FRIEND, settings, [
          { customerId: loyal.customerId, months: settings.loyalFriendMonths },
        ]);
        granted += 1;
        continue;
      }

      const qualifying = credits.filter((c) => c.available >= settings.friendMonths);
      if (qualifying.length >= settings.friendsRequired) {
        const spend = qualifying
          .slice(0, settings.friendsRequired)
          .map((c) => ({ customerId: c.customerId, months: settings.friendMonths }));
        await this.grant(referrerId, ReferralRewardReason.SEVERAL_FRIENDS, settings, spend);
        granted += 1;
        continue;
      }

      return granted;
    }

    this.logger.error(
      `referral sweep hit its per-customer cap for ${referrerId} -- the credit arithmetic is not converging`,
    );
    return granted;
  }

  /** Records the spend, creates the free subscription, provisions it,
   * and tells the customer.
   *
   * The spend is written **first and in the same transaction as the
   * reward row**. If provisioning then fails, the customer is owed a
   * subscription that an operator can grant by hand -- which is
   * recoverable. The other order is not: a granted reward with
   * unrecorded spend would be re-granted on every sweep, forever.
   */
  private async grant(
    referrerId: string,
    reason: ReferralRewardReason,
    settings: Awaited<ReturnType<ReferralSettingsService["get"]>>,
    spend: { customerId: string; months: number }[],
  ) {
    const reward = await this.prisma.$transaction(async (tx) => {
      for (const item of spend) {
        await tx.referralCredit.upsert({
          where: { referredCustomerId: item.customerId },
          create: { referredCustomerId: item.customerId, monthsSpent: item.months },
          update: { monthsSpent: { increment: item.months } },
        });
      }
      return tx.referralReward.create({
        data: { referrerId, reason, rewardDays: settings.rewardDays, sourceJson: spend },
      });
    });

    try {
      const subscription = await this.grantFreeTime(referrerId, settings);
      await this.prisma.referralReward.update({
        where: { id: reward.id },
        data: { subscriptionId: subscription.id },
      });
      await this.notifyReward(referrerId, settings);
    } catch (error) {
      // Deliberately not rethrown: the sweep must carry on for every
      // other customer, and the reward row is already a durable record
      // that this person is owed time.
      this.logger.error(
        `referral reward ${reward.id} for ${referrerId} was earned but could not be granted: ${String(error)}`,
      );
    }
  }

  /** Adds the free time on the plan the operator chose.
   *
   * Extends an existing active subscription on that plan rather than
   * creating a second one -- "a free month" means the customer's
   * service lasts a month longer, not that they now have two
   * subscriptions to understand. A customer with nothing on that plan
   * gets a new one.
   */
  private async grantFreeTime(
    referrerId: string,
    settings: Awaited<ReturnType<ReferralSettingsService["get"]>>,
  ) {
    const rewardPlanId = settings.rewardPlanId as string;
    const extraMs = settings.rewardDays * 24 * 60 * 60 * 1000;

    const existing = await this.prisma.subscription.findFirst({
      where: { customerId: referrerId, planId: rewardPlanId, status: SubscriptionStatus.ACTIVE },
      orderBy: { expireAt: "desc" },
    });

    if (existing) {
      // From the later of now and its current expiry, so extending an
      // already-lapsed-but-still-ACTIVE row gives a full period rather
      // than backdating the gift into the past.
      const from = existing.expireAt > new Date() ? existing.expireAt : new Date();
      return this.prisma.subscription.update({
        where: { id: existing.id },
        data: { expireAt: new Date(from.getTime() + extraMs) },
      });
    }

    const subscription = await this.subscriptionsService.create({
      customerId: referrerId,
      planId: rewardPlanId,
    });
    await this.prisma.subscription.update({
      where: { id: subscription.id },
      // The plan's own duration is not the reward's duration: the
      // operator may point the reward at an annual plan and still mean
      // a month.
      data: { expireAt: new Date(Date.now() + extraMs) },
    });
    // Every route the plan allows, so a rewarded customer gets the same
    // failover a paying one does.
    await this.protocolUsersService.provisionAll(subscription.id);
    return subscription;
  }

  private async notifyReward(
    referrerId: string,
    settings: Awaited<ReturnType<ReferralSettingsService["get"]>>,
  ) {
    const [referrer, plan] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: referrerId }, select: { email: true } }),
      this.prisma.subscriptionPlan.findUnique({
        where: { id: settings.rewardPlanId as string },
        select: { name: true },
      }),
    ]);
    if (!referrer) return;
    const mail = referralRewardEmail(settings.rewardDays, plan?.name ?? "your plan");
    await this.emailService.sendMail({ to: referrer.email, ...mail });
  }

  // -------------------------------------------------------------------
  // Credit arithmetic
  // -------------------------------------------------------------------

  /** Paid months per invited customer, minus what has already been
   * spent on a reward. */
  private async availableCredits(referrerId: string): Promise<FriendCredit[]> {
    const friends = await this.prisma.customer.findMany({
      where: { referredByCustomerId: referrerId },
      select: { id: true },
    });
    if (friends.length === 0) return [];

    const ids = friends.map((f) => f.id);
    const [earned, spent] = await Promise.all([
      this.paidMonthsByCustomer(ids),
      this.prisma.referralCredit.findMany({
        where: { referredCustomerId: { in: ids } },
        select: { referredCustomerId: true, monthsSpent: true },
      }),
    ]);
    const spentBy = new Map(spent.map((s) => [s.referredCustomerId, s.monthsSpent]));

    return ids
      .map((id) => ({
        customerId: id,
        available: (earned.get(id) ?? 0) - (spentBy.get(id) ?? 0),
      }))
      // Highest first, so the loyal-friend rule finds its candidate
      // without a second pass and the several-friends rule spends the
      // credit of those who have most to spare.
      .sort((a, b) => b.available - a.available);
  }

  /** Whole months of *paid* subscription each customer has accumulated.
   *
   * Counted from paid invoices rather than from subscriptions, because
   * an invoice is the record that money changed hands. A free trial, an
   * operator-granted subscription, and a referral reward itself all
   * create subscriptions and none of them should earn anybody a reward
   * -- otherwise a chain of referrals pays for itself.
   */
  private async paidMonthsByCustomer(customerIds: string[]): Promise<Map<string, number>> {
    const months = new Map<string, number>();
    if (customerIds.length === 0) return months;

    const invoices = await this.prisma.invoice.findMany({
      where: { customerId: { in: customerIds }, status: InvoiceStatus.PAID },
      select: { customerId: true, periodStart: true, periodEnd: true },
    });

    const days = new Map<string, number>();
    for (const invoice of invoices) {
      const span = invoice.periodEnd.getTime() - invoice.periodStart.getTime();
      if (span <= 0) continue;
      const asDays = span / (24 * 60 * 60 * 1000);
      days.set(invoice.customerId, (days.get(invoice.customerId) ?? 0) + asDays);
    }
    for (const [customerId, total] of days) {
      months.set(customerId, Math.floor(total / DAYS_PER_MONTH));
    }
    return months;
  }
}

/** Hides most of an address while leaving it recognisable to whoever
 * already knows the person.
 *
 * `alice@example.com` -> `a****e@example.com`. Short local parts are
 * masked entirely rather than partially, since `a*@x.com` gives away
 * almost everything about a two-character name.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";

  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 3) return `${"•".repeat(local.length)}${domain}`;
  return `${local[0]}${"•".repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}${domain}`;
}
