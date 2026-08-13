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
  ) {}

  list() {
    return this.prisma.paymentTransaction.findMany({ orderBy: { createdAt: "desc" } });
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
        : await this.resolveCryptoProvider(dto.provider as "NOWPAYMENTS" | "PLISIO");

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
        : await this.resolveCryptoProvider(dto.provider as "NOWPAYMENTS" | "PLISIO");

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

  /** Called from both webhook handlers once a provider confirms payment.
   * Idempotent (no-ops if the transaction isn't still PENDING) since
   * webhooks legitimately arrive more than once for the same event --
   * both Stripe and NowPayments document and expect this. */
  async confirmPayment(transactionId: string, rawPayload: unknown) {
    const transaction = await this.prisma.paymentTransaction.findUnique({ where: { id: transactionId } });
    if (!transaction) {
      this.logger.warn(`Webhook confirmed unknown payment transaction ${transactionId}`);
      return;
    }
    if (transaction.status !== "PENDING") return;

    await this.prisma.paymentTransaction.update({
      where: { id: transactionId },
      data: { status: "CONFIRMED", rawWebhookPayload: rawPayload as Prisma.InputJsonValue },
    });

    if (transaction.subscriptionId) {
      await this.renewSubscription(transaction.subscriptionId);
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
    try {
      await this.invoices.issueForPayment(transactionId);
    } catch (err) {
      this.logger.error(
        `Payment ${transactionId} confirmed but its invoice could not be issued: ${(err as Error).message}`,
      );
    }
  }

  async markFailed(transactionId: string, rawPayload: unknown) {
    const transaction = await this.prisma.paymentTransaction.findUnique({ where: { id: transactionId } });
    if (!transaction || transaction.status !== "PENDING") return;

    await this.prisma.paymentTransaction.update({
      where: { id: transactionId },
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
  private async renewSubscription(subscriptionId: string) {
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
    const firstActivation = subscription.status === SubscriptionStatus.PENDING;
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
    // has users that exist but are switched off, and provisionAll only
    // fills gaps -- it would leave a disabled row disabled.
    const existingUsers = await this.prisma.protocolUser.findMany({ where: { subscriptionId } });
    for (const user of existingUsers.filter((u) => u.status === "DISABLED")) {
      await this.protocolUsersService.setEnabled(user.id, true);
    }

    // Every route the plan allows, not just the plan's default one, so
    // the client can fail over between protocols without needing to
    // reach us. defaultRouteId still decides which the client tries
    // first; it no longer decides which exist.
    const provisioned = await this.protocolUsersService.provisionAll(subscriptionId);
    if (existingUsers.length === 0 && provisioned.length === 0) {
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
    if (transaction.status !== "PENDING") return transaction;

    if (transaction.provider === "STRIPE") {
      const intent = await this.stripe.retrievePaymentIntent(transaction.providerRef);
      if (intent.status === "succeeded") {
        await this.confirmPayment(transaction.id, intent);
      } else if (intent.status === "canceled") {
        await this.markFailed(transaction.id, intent);
      }
    } else {
      const { paymentStatus } = await this.nowpayments.getPaymentStatus(transaction.providerRef);
      if (paymentStatus === "finished" || paymentStatus === "confirmed") {
        await this.confirmPayment(transaction.id, { paymentStatus });
      } else if (paymentStatus === "failed" || paymentStatus === "expired") {
        await this.markFailed(transaction.id, { paymentStatus });
      }
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
}
