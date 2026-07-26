import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";

@Injectable()
export class StripeProvider {
  private readonly logger = new Logger(StripeProvider.name);
  private readonly client?: Stripe;

  constructor(private readonly config: ConfigService) {
    const secretKey = this.config.get<string>("billing.stripeSecretKey");
    if (secretKey) {
      this.client = new Stripe(secretKey);
    } else {
      this.logger.warn("STRIPE_SECRET_KEY not set -- Stripe payments are disabled");
    }
  }

  private requireClient(): Stripe {
    if (!this.client) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
    return this.client;
  }

  /** Creates a hosted Checkout Session and returns the URL to send the
   * customer to.
   *
   * The desktop client uses this rather than the PaymentIntent below.
   * Confirming a PaymentIntent in-app means rendering card fields inside
   * our own process, which puts card data in a VPN client's memory and
   * makes us responsible for 3-D Secure. A hosted page opened in the
   * system browser keeps all of that at Stripe, and the app just waits
   * for the subscription to activate -- the webhook confirms payment
   * either way, so nothing depends on the app seeing the result.
   *
   * `transactionId` rides in metadata so the webhook can match the
   * payment back to our own record, exactly as the PaymentIntent path
   * does. */
  async createCheckoutSession(
    amountUsd: number,
    transactionId: string,
    planName: string,
    returnUrl: string,
  ): Promise<{ providerRef: string; url: string }> {
    const session = await this.requireClient().checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(amountUsd * 100),
            product_data: { name: `Neoxify ${planName}` },
          },
        },
      ],
      // Both land back on our own page, which explains what to do next
      // rather than dumping the customer on a Stripe URL.
      success_url: `${returnUrl}?status=success`,
      cancel_url: `${returnUrl}?status=cancelled`,
      metadata: { paymentTransactionId: transactionId },
      payment_intent_data: { metadata: { paymentTransactionId: transactionId } },
    });
    if (!session.url) {
      throw new Error("Stripe did not return a Checkout URL for the created session");
    }
    // The PaymentIntent usually doesn't exist yet -- Stripe creates it
    // when the customer actually pays -- so the session id is normally
    // what gets recorded. Either way the webhook matches on the metadata
    // above rather than on this reference, so it only has to be
    // something meaningful to look at later.
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
    return { providerRef: paymentIntentId ?? session.id, url: session.url };
  }

  /** Creates a PaymentIntent for callers that render their own payment
   * UI. Retained for the admin/panel path; the desktop client uses
   * createCheckoutSession above. */
  async createPaymentIntent(amountUsd: number, transactionId: string): Promise<{ providerRef: string; clientSecret: string }> {
    const intent = await this.requireClient().paymentIntents.create({
      amount: Math.round(amountUsd * 100),
      currency: "usd",
      metadata: { paymentTransactionId: transactionId },
      automatic_payment_methods: { enabled: true },
    });
    if (!intent.client_secret) {
      throw new Error("Stripe did not return a client_secret for the created PaymentIntent");
    }
    return { providerRef: intent.id, clientSecret: intent.client_secret };
  }

  retrievePaymentIntent(providerRef: string): Promise<Stripe.PaymentIntent> {
    return this.requireClient().paymentIntents.retrieve(providerRef);
  }

  /** Verifies the webhook signature and parses the event. Throws on a
   * bad signature -- that's what actually protects this intentionally-
   * unauthenticated endpoint (see webhooks.controller.ts), not a guard. */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const webhookSecret = this.config.get<string>("billing.stripeWebhookSecret");
    if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
    return this.requireClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  }
}
