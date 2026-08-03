import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import { PaymentSettingsService } from "../../payment-settings/payment-settings.service";

@Injectable()
export class StripeProvider {
  private readonly logger = new Logger(StripeProvider.name);
  /** Cached client plus the key it was built from, so a key changed in the
   * panel takes effect without restarting the backend -- but a normal
   * request does not pay to rebuild the SDK every time. */
  private cached?: { key: string; client: Stripe };

  constructor(
    private readonly config: ConfigService,
    private readonly paymentSettings: PaymentSettingsService,
  ) {}

  /** Resolves the secret key: the panel first, then the environment.
   *
   * The env fallback is deliberate and not dead weight. The running
   * deployment was configured through STRIPE_SECRET_KEY before this
   * existed, and dropping it would take payments down the moment this
   * ships and stay down until someone retyped the key into the panel.
   */
  private async secretKey(): Promise<string | undefined> {
    const configured = await this.paymentSettings.stripe();
    return configured?.secretKey ?? this.config.get<string>("billing.stripeSecretKey");
  }

  private async requireClient(): Promise<Stripe> {
    const key = await this.secretKey();
    if (!key) {
      throw new Error("Stripe is not configured -- add a secret key in Settings > Payments");
    }
    if (this.cached?.key !== key) {
      this.cached = { key, client: new Stripe(key) };
    }
    return this.cached.client;
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
    const session = await (await this.requireClient()).checkout.sessions.create({
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
    const intent = await (await this.requireClient()).paymentIntents.create({
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

  async retrievePaymentIntent(providerRef: string): Promise<Stripe.PaymentIntent> {
    return (await this.requireClient()).paymentIntents.retrieve(providerRef);
  }

  /** Verifies the webhook signature and parses the event. Throws on a
   * bad signature -- that's what actually protects this intentionally-
   * unauthenticated endpoint (see webhooks.controller.ts), not a guard. */
  async constructEvent(rawBody: Buffer, signature: string): Promise<Stripe.Event> {
    // Same panel-then-environment order as the secret key, for the same
    // reason: the running deployment configured this through env.
    const configured = await this.paymentSettings.stripe();
    const webhookSecret = configured?.webhookSecret ?? this.config.get<string>("billing.stripeWebhookSecret");
    if (!webhookSecret) {
      throw new Error("No Stripe webhook secret configured -- add one in Settings > Payments");
    }
    return (await this.requireClient()).webhooks.constructEvent(rawBody, signature, webhookSecret);
  }
}
