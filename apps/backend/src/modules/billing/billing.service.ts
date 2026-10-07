import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { NowPaymentsProvider } from "./providers/nowpayments.provider";
import { PlisioProvider } from "./providers/plisio.provider";
import { ConfigService } from "@nestjs/config";
import { PaymentSettingsService } from "../payment-settings/payment-settings.service";
import { StripeProvider } from "./providers/stripe.provider";
import { InvoicesService } from "../invoices/invoices.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { verifyAppleTransaction, type VerifiedTransaction } from "./providers/apple-iap.provider";
import type { ListWindow, Page } from "../../common/pagination";

/** What a payment row looks like on the list, and nothing else.
 *
 * `rawWebhookPayload` is deliberately absent. It is the provider's
 * webhook body stored verbatim -- Stripe's event object, Plisio's
 * callback form -- so it is both the largest column on the table and the
 * one nobody asked for: no panel file reads a payment transaction at
 * all, and the only caller that has ever needed the raw body is
 * `reconcile`, which loads the single row it is reconciling through
 * `get()`. Sending an unfiltered third-party payload to every caller of
 * a list route is how a field nobody chose to expose ends up exposed.
 *
 * The rest are named rather than left to `findMany`'s default so that
 * adding a column to PaymentTransaction cannot silently widen this
 * response again. */
const PAYMENT_LIST_FIELDS = {
  id: true,
  customerId: true,
  subscriptionId: true,
  provider: true,
  providerRef: true,
  amountUsd: true,
  currency: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentTransactionSelect;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly protocolUsersService: ProtocolUsersService,
    private readonly stripe: StripeProvider,
    private readonly nowpayments: NowPaymentsProvider,
    private readonly plisio: PlisioProvider,
    private readonly config: ConfigService,
    private readonly paymentSettings: PaymentSettingsService,
    private readonly invoices: InvoicesService,
    // Appended, like every dependency added here since: these are
    // positional, and inserting one silently re-binds every argument
    // after it.
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /** Every payment ever taken, newest first -- bounded.
   *
   * This table only grows: it gains a row per payment attempt, including
   * the failed and abandoned ones, and nothing prunes it. Reading all of
   * it to render a page of an operator's table is the pattern described
   * in common/pagination.ts, and the count is what lets the panel say
   * how many there really are rather than inferring a total from the
   * page it happens to be holding. */
  async list(
    window: ListWindow,
  ): Promise<Page<Prisma.PaymentTransactionGetPayload<{ select: typeof PAYMENT_LIST_FIELDS }>>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.paymentTransaction.findMany({
        orderBy: { createdAt: "desc" },
        select: PAYMENT_LIST_FIELDS,
        take: window.take,
        skip: window.skip,
      }),
      this.prisma.paymentTransaction.count(),
    ]);

    return { items, total };
  }

  async get(id: string) {
    const transaction = await this.prisma.paymentTransaction.findUnique({ where: { id } });
    if (!transaction) throw new NotFoundException("Payment transaction not found");
    return transaction;
  }

  /** Creates a PaymentTransaction row first (so it has a stable id to
   * hand the provider as metadata/order_id), then calls out to whichever
   * provider was requested. Both provider responses are headless --
   * a client_secret for Stripe's SDK to confirm, or a pay-to address for
   * NowPayments -- never a hosted-page redirect URL. */
  async create(dto: CreatePaymentDto) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: dto.subscriptionId },
      include: { plan: true },
    });
    if (!subscription) throw new BadRequestException("Subscription not found");

    // Resolved BEFORE the row is written, not after. Recording
    // dto.provider meant a Plisio payment was filed as NOWPAYMENTS --
    // the bridge swapped the provider at call time but the row had
    // already been created with the name the client sent. Revenue then
    // reconciles against the wrong provider, which is quiet and
    // expensive to untangle later.
    const provider =
      dto.provider === "STRIPE"
        ? ("STRIPE" as const)
        : await this.resolveCryptoProvider(dto.provider);

    const transaction = await this.prisma.paymentTransaction.create({
      data: {
        customerId: subscription.customerId,
        subscriptionId: subscription.id,
        provider,
        // Placeholder until the provider call below returns a real
        // reference -- never exposed to a caller, overwritten before
        // this function returns.
        providerRef: `pending-${subscription.id}-${Date.now()}`,
        amountUsd: subscription.plan.priceUsd,
        // Plisio prices in USD and lets the customer pick the coin on
        // its hosted page, so there is no single pay-currency to record
        // up front the way NowPayments has.
        // NowPayments is invoiced in one fixed coin; Stripe and Plisio
        // are priced in USD (Plisio lets the payer pick the coin, so
        // recording usdttrc20 for it was simply wrong -- this test was
        // paid in TRX).
        currency: provider === "NOWPAYMENTS" ? "usdttrc20" : "usd",
        status: "PENDING",
      },
    });

    if (provider === "STRIPE") {
      const { providerRef, clientSecret } = await this.stripe.createPaymentIntent(
        Number(subscription.plan.priceUsd),
        transaction.id,
      );
      await this.prisma.paymentTransaction.update({ where: { id: transaction.id }, data: { providerRef } });
      return { transactionId: transaction.id, provider: "STRIPE" as const, clientSecret };
    }

    if (provider === "PLISIO") {
      const invoice = await this.plisio.createInvoice({
        orderNumber: transaction.id,
        orderName: subscription.plan.name,
        amountUsd: String(subscription.plan.priceUsd),
        callbackUrl: this.plisioCallbackUrl(),
      });
      await this.prisma.paymentTransaction.update({
        where: { id: transaction.id },
        data: { providerRef: invoice.txnId },
      });
      // checkoutUrl, not payAddress: Plisio hosts the payment page, so
      // the client opens a URL exactly as it does for Stripe rather than
      // rendering an address to send coins to.
      return { transactionId: transaction.id, provider: "PLISIO" as const, checkoutUrl: invoice.invoiceUrl };
    }

    const payment = await this.nowpayments.createPayment(Number(subscription.plan.priceUsd), transaction.id);
    await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: { providerRef: payment.paymentId },
    });
    return {
      transactionId: transaction.id,
      provider: "NOWPAYMENTS" as const,
      payAddress: payment.payAddress,
      payAmount: payment.payAmount,
      payCurrency: payment.payCurrency,
    };
  }

  /** Starts a payment the desktop client can complete without handling
   * card data itself.
   *
   * Same PaymentTransaction bookkeeping as create() above -- the only
   * difference is what the customer is handed: a hosted Checkout URL for
   * cards, or a pay-to address for crypto. Both are confirmed by the
   * provider's webhook, so the app never has to be told the outcome; it
   * just watches its own subscription become active. */
  async createForClient(dto: CreatePaymentDto, returnUrl: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: dto.subscriptionId },
      include: { plan: true },
    });
    if (!subscription) throw new BadRequestException("Subscription not found");

    // Resolved BEFORE the row is written, not after. Recording
    // dto.provider meant a Plisio payment was filed as NOWPAYMENTS --
    // the bridge swapped the provider at call time but the row had
    // already been created with the name the client sent. Revenue then
    // reconciles against the wrong provider, which is quiet and
    // expensive to untangle later.
    const provider =
      dto.provider === "STRIPE"
        ? ("STRIPE" as const)
        : await this.resolveCryptoProvider(dto.provider);

    const transaction = await this.prisma.paymentTransaction.create({
      data: {
        customerId: subscription.customerId,
        subscriptionId: subscription.id,
        provider,
        providerRef: `pending-${subscription.id}-${Date.now()}`,
        amountUsd: subscription.plan.priceUsd,
        // NowPayments is invoiced in one fixed coin; Stripe and Plisio
        // are priced in USD (Plisio lets the payer pick the coin, so
        // recording usdttrc20 for it was simply wrong -- this test was
        // paid in TRX).
        currency: provider === "NOWPAYMENTS" ? "usdttrc20" : "usd",
        status: "PENDING",
      },
    });

    if (provider === "STRIPE") {
      const { providerRef, url } = await this.stripe.createCheckoutSession(
        Number(subscription.plan.priceUsd),
        transaction.id,
        subscription.plan.name,
        returnUrl,
      );
      await this.prisma.paymentTransaction.update({ where: { id: transaction.id }, data: { providerRef } });
      return { transactionId: transaction.id, provider: "STRIPE" as const, checkoutUrl: url };
    }

    if (provider === "PLISIO") {
      const invoice = await this.plisio.createInvoice({
        orderNumber: transaction.id,
        orderName: subscription.plan.name,
        amountUsd: String(subscription.plan.priceUsd),
        callbackUrl: this.plisioCallbackUrl(),
        // Where Plisio sends the customer after paying. Only the
        // customer-facing purchase has somewhere to send them back to.
        successUrl: returnUrl,
      });
      await this.prisma.paymentTransaction.update({
        where: { id: transaction.id },
        data: { providerRef: invoice.txnId },
      });
      return { transactionId: transaction.id, provider: "PLISIO" as const, checkoutUrl: invoice.invoiceUrl };
    }

    const payment = await this.nowpayments.createPayment(Number(subscription.plan.priceUsd), transaction.id);
    await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: { providerRef: payment.paymentId },
    });
    return {
      transactionId: transaction.id,
      provider: "NOWPAYMENTS" as const,
      payAddress: payment.payAddress,
      payAmount: payment.payAmount,
      payCurrency: payment.payCurrency,
    };
  }

  /** Called from every webhook handler once a provider confirms payment.
   *
   * Idempotent, since webhooks legitimately arrive more than once for the
   * same event -- both Stripe and NowPayments document and expect this.
   * The transition is one conditional write, not a read and then an
   * update: two deliveries of the same success racing each other used to
   * both read PENDING and both renew, a second term for one payment. Only
   * the delivery whose write lands goes on to renew and invoice.
   *
   * FAILED is confirmable as well as PENDING. The provider has just said
   * the money arrived, and that outranks anything we concluded earlier: a
   * Stripe PaymentIntent whose first card was declined can still succeed
   * on a second, and a crypto invoice marked expired can still be paid.
   * Refusing those left a customer charged with nothing to show for it. */
  async confirmPayment(transactionId: string, rawPayload: unknown) {
    const transaction = await this.prisma.paymentTransaction.findUnique({ where: { id: transactionId } });
    if (!transaction) {
      this.logger.warn(`Webhook confirmed unknown payment transaction ${transactionId}`);
      return;
    }
    if (transaction.status !== "PENDING" && transaction.status !== "FAILED") return;

    const { count } = await this.prisma.paymentTransaction.updateMany({
      where: { id: transactionId, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "CONFIRMED", rawWebhookPayload: rawPayload as Prisma.InputJsonValue },
    });
    if (count === 0) return;
    if (transaction.status === "FAILED") {
      this.logger.warn(
        `Payment ${transactionId} (${transaction.provider}) was marked FAILED and has now been confirmed by the provider`,
      );
    }

    if (transaction.subscriptionId) {
      await this.renewSubscription(transaction.subscriptionId, transactionId);
    }

    // Issued here, in the same flow that activates the subscription,
    // rather than by a job that sweeps for un-invoiced payments later.
    // An invoice that depends on a separate process running is an
    // invoice that is sometimes missing, and the customer notices that
    // before the operator does.
    //
    // A failure here must not undo a confirmed payment: the money has
    // moved and the subscription is live. Logged loudly instead, since a
    // paid-but-uninvoiced transaction is a real bookkeeping gap that
    // someone has to fix by hand.
    // Not for App Store purchases. Apple is the merchant of record
    // there: it takes the customer's money, keeps its commission, remits
    // the rest, and sends the customer its own receipt. An invoice from
    // us for the full price would describe a transaction that did not
    // happen, and would be wrong in exactly the way an auditor cares
    // about.
    if (transaction.provider === "APPLE_IAP") return;

    try {
      await this.invoices.issueForPayment(transactionId);
    } catch (err) {
      this.logger.error(
        `Payment ${transactionId} confirmed but its invoice could not be issued: ${(err as Error).message}`,
      );
    }
  }

  /** Conditional for the same reason confirmPayment is: a failure that
   * lands just after a confirmation must not overwrite it. */
  async markFailed(transactionId: string, rawPayload: unknown) {
    await this.prisma.paymentTransaction.updateMany({
      where: { id: transactionId, status: "PENDING" },
      data: { status: "FAILED", rawWebhookPayload: rawPayload as Prisma.InputJsonValue },
    });
  }

  /** Extends the subscription from its own current expiry (not "now"),
   * so renewing before expiry doesn't lose already-paid-for time, and
   * resets usage for the new period.
   *
   * Then either provisions or re-enables connection credentials,
   * depending on whether this is the subscription's first confirmed
   * payment or a renewal:
   * - **First payment** (no ProtocolUser exists yet -- true for every
   *   customer-initiated purchase, since `POST /customer/subscriptions`
   *   only creates the Subscription row, deliberately not a working VPN
   *   account, until payment actually clears): provisions one now via
   *   the plan's `defaultRouteId`, the same hot-provisioning path M3/M4
   *   already proved (`ProtocolUsersService.create()`).
   * - **Renewal** (a ProtocolUser already exists, possibly `DISABLED` by
   *   a prior quota/expiry suspension): re-enables it -- the exact
   *   reverse of `UsageService.disableProtocolUsers`, reusing
   *   `ProtocolUsersService.setEnabled(true)`. */
  private async renewSubscription(subscriptionId: string, transactionId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: true },
    });
    if (!subscription) return;

    // Extending from the existing expiry is right for a renewal -- time
    // already paid for should not be thrown away -- but wrong for a first
    // activation. A self-serve purchase creates the subscription PENDING
    // with a provisional expireAt already a full term out, so treating
    // that as time the customer owns handed them two terms for one
    // payment: a 30-day plan activated as 60 days. Reported after a real
    // purchase.
    //
    // Status is the discriminator rather than the date, because the date
    // cannot distinguish "provisional, never paid for" from "genuinely
    // owned".
    //
    // CANCELLED needs one more question. The stale-pending sweep cancels
    // unpaid attempts, and a payment can still confirm on one afterwards
    // (a Checkout page is payable for 24 hours; crypto confirms when it
    // confirms). Its expiry is the same provisional date, so it is a first
    // activation too -- unless the subscription was ever paid for, which
    // is what distinguishes it from one an operator or an account deletion
    // cancelled. The sweep now also pulls the expiry in, so this matters
    // for the rows it cancelled before it did. This payment is already
    // CONFIRMED by now, hence excluded.
    const firstActivation =
      subscription.status === SubscriptionStatus.PENDING ||
      (subscription.status === SubscriptionStatus.CANCELLED &&
        (await this.prisma.paymentTransaction.count({
          where: { subscriptionId, status: "CONFIRMED", id: { not: transactionId } },
        })) === 0);
    const base =
      !firstActivation && subscription.expireAt > new Date() ? subscription.expireAt : new Date();
    const newExpireAt = new Date(base.getTime() + subscription.plan.durationDays * 24 * 60 * 60 * 1000);

    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: "ACTIVE",
        expireAt: newExpireAt,
        dataCapBytes: subscription.plan.dataCapBytes,
        dataUsedBytes: 0n,
        // A fresh billing period gets fresh warning eligibility -- these
        // "already warned" flags must not carry over from the period that
        // just ended (M16).
        lowDataWarningSentAt: null,
        expiryWarningSentAt: null,
      },
    });

    // Re-enable before provisioning: a renewal after a quota suspension
    // has users that exist but are switched off, and provisionAll works
    // in whole credentials rather than their status -- it adds the ones
    // a plan lacks and revokes the ones it no longer allows, and would
    // leave a disabled row sitting there disabled either way.
    const existingUsers = await this.prisma.protocolUser.findMany({ where: { subscriptionId } });
    for (const user of existingUsers.filter((u) => u.status === "DISABLED")) {
      await this.protocolUsersService.setEnabled(user.id, true);
    }

    // Every route the plan allows, not just the plan's default one, so
    // the client can fail over between protocols without needing to
    // reach us. defaultRouteId still decides which the client tries
    // first; it no longer decides which exist.
    //
    // Caught: the payment is confirmed and the subscription already
    // extended above, so a provisioning failure (a plan whose routes are
    // all down throws by design) must not also cost the customer the
    // invoice that confirmPayment issues after this returns. Logged at
    // error -- a paid subscription with nothing to connect with is
    // someone's job to fix today.
    let provisioned: { created: unknown[] } = { created: [] };
    try {
      provisioned = await this.protocolUsersService.provisionAll(subscriptionId);
    } catch (err) {
      this.logger.error(
        `Subscription ${subscriptionId} renewed but could not be provisioned: ${(err as Error).message}`,
      );
    }
    if (existingUsers.length === 0 && provisioned.created.length === 0) {
      this.logger.warn(
        `Subscription ${subscriptionId} (plan ${subscription.planId}) had a payment confirmed but no enabled route matches its allowed protocols -- no protocol user was provisioned`,
      );
    }

    this.logger.log(`Subscription ${subscriptionId} renewed through ${newExpireAt.toISOString()}`);
  }

  /** Admin safety net for a missed/lost webhook: re-checks the
   * provider's own payment status directly and confirms/fails the
   * transaction accordingly -- the "manual reconcile" the architecture
   * plan calls for. */
  async reconcile(id: string) {
    const transaction = await this.get(id);
    // FAILED too: a row written off by a declined attempt or an expired
    // invoice can still have been paid (see confirmPayment), and this is
    // how one already stuck that way is put right.
    if (transaction.status !== "PENDING" && transaction.status !== "FAILED") return transaction;

    // One branch per provider. This used to be Stripe and "everything
    // else", and everything else went to NowPayments -- so a Plisio row
    // asked NowPayments about a Plisio id and could never be reconciled.
    switch (transaction.provider) {
      case "STRIPE": {
        // Card payments from the apps go through Checkout, and what they
        // record is the session id: the PaymentIntent does not exist when
        // the session is created. paymentIntents.retrieve("cs_...") failed
        // with "No such payment_intent", every time.
        if (transaction.providerRef.startsWith("cs_")) {
          const session = await this.stripe.retrieveCheckoutSession(transaction.providerRef);
          if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
            await this.confirmPayment(transaction.id, session);
          } else if (session.status === "expired") {
            await this.markFailed(transaction.id, session);
          }
          break;
        }
        const intent = await this.stripe.retrievePaymentIntent(transaction.providerRef);
        if (intent.status === "succeeded") {
          await this.confirmPayment(transaction.id, intent);
        } else if (intent.status === "canceled") {
          await this.markFailed(transaction.id, intent);
        }
        break;
      }
      case "PLISIO": {
        const status = await this.plisio.getOperationStatus(transaction.providerRef);
        // The same reading of a status as the callback (see
        // WebhooksController.plisioWebhook): a mismatch is left for a
        // human, never confirmed and never failed.
        const outcome = this.plisio.classify(status);
        if (outcome === "paid") {
          await this.confirmPayment(transaction.id, { status });
        } else if (outcome === "failed") {
          await this.markFailed(transaction.id, { status });
        }
        break;
      }
      case "NOWPAYMENTS": {
        const { paymentStatus } = await this.nowpayments.getPaymentStatus(transaction.providerRef);
        if (paymentStatus === "finished" || paymentStatus === "confirmed") {
          await this.confirmPayment(transaction.id, { paymentStatus });
        } else if (paymentStatus === "failed" || paymentStatus === "expired") {
          await this.markFailed(transaction.id, { paymentStatus });
        }
        break;
      }
      default:
        // An App Store purchase is verified when it is redeemed and has
        // nothing to look up afterwards.
        throw new BadRequestException(`A ${transaction.provider} payment cannot be reconciled`);
    }

    return this.get(id);
  }

  /** Where Plisio posts invoice updates.
   *
   * Built from the configured public API address rather than hardcoded,
   * because a callback aimed at the wrong host is a payment that is
   * taken and never confirmed -- the customer is charged and gets
   * nothing, which is the worst failure this file can produce.
   *
   * The provider appends ?json=true itself; without it Plisio posts
   * PHP-serialised data that nothing here can parse.
   */
  private plisioCallbackUrl(): string {
    const base = this.config.get<string>("publicApiUrl");
    if (!base) {
      throw new ServiceUnavailableException(
        "PUBLIC_API_URL is not configured, so Plisio has nowhere to confirm payments to.",
      );
    }
    return `${base.replace(/\/$/, "")}/billing/webhooks/plisio`;
  }

  /**
   * Which crypto provider a request should actually use.
   *
   * Every client shipped so far hardcodes NOWPAYMENTS behind its
   * "Crypto" button -- desktop 0.9.x and the current Android build both
   * do -- so switching providers server-side would strand every
   * installed app on a provider with no key, which is exactly what
   * happened: pressing Crypto returned "Internal server error".
   *
   * The customer pressed "pay with crypto", not "pay with NowPayments".
   * Honouring that intent means resolving to whichever crypto provider
   * is actually configured rather than the name the client happened to
   * send. An explicit PLISIO request is always honoured; a NOWPAYMENTS
   * request falls through to Plisio only when NowPayments genuinely
   * cannot serve it.
   *
   * Remove once the shipped clients ask /customer/billing/providers and
   * send the right name themselves.
   */
  private async resolveCryptoProvider(requested: "NOWPAYMENTS" | "PLISIO") {
    if (requested === "PLISIO") return "PLISIO" as const;
    const available = await this.paymentSettings.availableProviders();
    if (available.includes("NOWPAYMENTS")) return "NOWPAYMENTS" as const;
    if (available.includes("PLISIO")) {
      this.logger.log("Crypto requested as NOWPAYMENTS but only Plisio is configured -- using Plisio");
      return "PLISIO" as const;
    }
    return "NOWPAYMENTS" as const;
  }

  /** Turns a finished App Store purchase into a subscription.
   *
   * Unlike every other provider here there is no pending phase and no
   * webhook: by the time the app calls this, Apple has already taken
   * the customer's money. So this verifies, then activates, in one go.
   *
   * It is also the restore path. Apple expects a customer who reinstalls
   * or changes phone to get their purchase back without paying again,
   * and the app replays the same signed transaction to do it -- which is
   * indistinguishable from an attacker replaying it, so the two are
   * handled by the same rule: a transaction id is worth exactly one
   * subscription, to exactly one customer, forever.
   */
  async redeemApplePurchase(customerId: string, signedTransaction: string) {
    const bundleId = this.config.get<string>("APPLE_BUNDLE_ID");
    if (!bundleId) {
      this.logger.error("APPLE_BUNDLE_ID is not configured; App Store purchases cannot be verified");
      throw new BadRequestException("Purchases are not available right now");
    }

    let verified: VerifiedTransaction;
    try {
      verified = verifyAppleTransaction(signedTransaction, bundleId);
    } catch (err) {
      // Logged, never returned. Every failure here describes a forgery,
      // and naming which check it tripped tells whoever is probing us
      // what to fix.
      this.logger.warn(`App Store purchase rejected: ${(err as Error).message}`);
      throw new BadRequestException("That purchase could not be verified");
    }

    // A sandbox transaction is genuinely signed by Apple, so the
    // signature check passes and cannot be what stops it. TestFlight and
    // the simulator both mint them freely, which would make a paid
    // subscription free for anybody willing to install a beta build.
    if (verified.environment !== "Production" && this.config.get<string>("APPLE_ALLOW_SANDBOX") !== "true") {
      this.logger.warn(`Refused a ${verified.environment} App Store purchase in production`);
      throw new BadRequestException("That purchase could not be verified");
    }

    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { appleProductId: verified.productId },
    });
    // Not a customer error: it means a product exists in App Store
    // Connect that nothing here maps to, which is an operator mistake
    // and one the customer has already been charged for.
    if (!plan || !plan.isActive) {
      this.logger.error(
        `App Store product ${verified.productId} maps to no active plan; a customer has paid for nothing`,
      );
      throw new BadRequestException("That purchase could not be matched to a plan");
    }

    const already = await this.prisma.paymentTransaction.findUnique({
      where: { provider_providerRef: { provider: "APPLE_IAP", providerRef: verified.transactionId } },
    });
    if (already) {
      if (already.customerId !== customerId) {
        // Somebody is replaying a transaction that belongs to another
        // account. The honest answer to the customer is that it is not
        // theirs to redeem.
        this.logger.warn(
          `App Store transaction ${verified.transactionId} replayed against a different customer`,
        );
        throw new BadRequestException("That purchase belongs to a different account");
      }
      // Their own purchase, seen again: a restore, or a retry after a
      // dropped response. Same answer as the first time, no second
      // subscription.
      return { subscriptionId: already.subscriptionId, alreadyRedeemed: true };
    }

    const subscription = await this.subscriptions.createOrReusePending(customerId, plan.id);

    let transaction;
    try {
      transaction = await this.prisma.paymentTransaction.create({
        data: {
          customerId,
          subscriptionId: subscription.id,
          provider: "APPLE_IAP",
          // The transaction id IS the idempotency key, which is why it
          // goes in the column with the unique constraint on it rather
          // than into the payload.
          providerRef: verified.transactionId,
          // What the plan costs us to honour, not what Apple charged or
          // what it remits after commission. Apple's price is set in App
          // Store Connect and its cut is not visible here, so recording
          // anything else would be a guess dressed as a figure.
          amountUsd: plan.priceUsd,
          currency: "usd",
          status: "PENDING",
          rawWebhookPayload: verified as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Two devices redeeming the same purchase at once. The unique
      // constraint is the arbiter; the loser reports what the winner
      // already did rather than failing in front of a paying customer.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await this.prisma.paymentTransaction.findUnique({
          where: { provider_providerRef: { provider: "APPLE_IAP", providerRef: verified.transactionId } },
        });
        return { subscriptionId: winner?.subscriptionId ?? subscription.id, alreadyRedeemed: true };
      }
      throw err;
    }

    await this.confirmPayment(transaction.id, verified);
    return { subscriptionId: subscription.id, alreadyRedeemed: false };
  }
}
