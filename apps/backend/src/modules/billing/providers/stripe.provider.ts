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

  /** Creates a PaymentIntent, not a hosted Checkout Session -- headless
   * by design, so a customer confirms payment inside the app/website's
   * own UI (Stripe's PaymentSheet/Elements against this client_secret)
   * instead of being redirected out to a Stripe-hosted page. See the
   * in-app-purchase requirement in project memory. */
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
