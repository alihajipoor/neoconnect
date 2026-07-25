import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { NowPaymentsProvider } from "./providers/nowpayments.provider";
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

    const transaction = await this.prisma.paymentTransaction.create({
      data: {
        customerId: subscription.customerId,
        subscriptionId: subscription.id,
        provider: dto.provider,
        // Placeholder until the provider call below returns a real
        // reference -- never exposed to a caller, overwritten before
        // this function returns.
        providerRef: `pending-${subscription.id}-${Date.now()}`,
        amountUsd: subscription.plan.priceUsd,
        currency: dto.provider === "STRIPE" ? "usd" : "usdttrc20",
        status: "PENDING",
      },
    });

    if (dto.provider === "STRIPE") {
      const { providerRef, clientSecret } = await this.stripe.createPaymentIntent(
        Number(subscription.plan.priceUsd),
        transaction.id,
      );
      await this.prisma.paymentTransaction.update({ where: { id: transaction.id }, data: { providerRef } });
      return { transactionId: transaction.id, provider: "STRIPE" as const, clientSecret };
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

    const transaction = await this.prisma.paymentTransaction.create({
      data: {
        customerId: subscription.customerId,
        subscriptionId: subscription.id,
        provider: dto.provider,
        providerRef: `pending-${subscription.id}-${Date.now()}`,
        amountUsd: subscription.plan.priceUsd,
        currency: dto.provider === "STRIPE" ? "usd" : "usdttrc20",
        status: "PENDING",
      },
    });

    if (dto.provider === "STRIPE") {
      const { providerRef, url } = await this.stripe.createCheckoutSession(
        Number(subscription.plan.priceUsd),
        transaction.id,
        subscription.plan.name,
        returnUrl,
      );
      await this.prisma.paymentTransaction.update({ where: { id: transaction.id }, data: { providerRef } });
      return { transactionId: transaction.id, provider: "STRIPE" as const, checkoutUrl: url };
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

    const base = subscription.expireAt > new Date() ? subscription.expireAt : new Date();
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

    const existingUsers = await this.prisma.protocolUser.findMany({ where: { subscriptionId } });
    if (existingUsers.length === 0) {
      if (subscription.plan.defaultRouteId) {
        await this.protocolUsersService.create({ subscriptionId, routeId: subscription.plan.defaultRouteId });
      } else {
        this.logger.warn(
          `Subscription ${subscriptionId} (plan ${subscription.planId}) had a payment confirmed but the plan has no defaultRouteId configured -- no protocol user was provisioned`,
        );
      }
    } else {
      for (const user of existingUsers.filter((u) => u.status === "DISABLED")) {
        await this.protocolUsersService.setEnabled(user.id, true);
      }
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
}
