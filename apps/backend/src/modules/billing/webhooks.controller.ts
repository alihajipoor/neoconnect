import { BadRequestException, Controller, Get, Header, Headers, Post, Query, Req, type RawBodyRequest } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request } from "express";
import { BillingService } from "./billing.service";
import { checkoutReturnPage } from "../customer/checkout-return-page";
import { NowPaymentsProvider } from "./providers/nowpayments.provider";
import { StripeProvider } from "./providers/stripe.provider";

// Intentionally unauthenticated (no JwtAuthGuard) -- these are called by
// Stripe/NowPayments themselves, not a logged-in admin or customer.
// Signature verification is what actually protects them, same pattern as
// enrollment.controller.ts's unauthenticated claim endpoint from M2.
// Also exempt from IP-based rate limiting (SkipThrottle): a legitimate
// provider's retry behavior after a transient failure shouldn't get
// blocked, and signature verification is already the real gate here.
/** Where Stripe returns the customer's browser after Checkout.
 *
 * Lives here rather than on CustomerController because that controller
 * requires a customer JWT, and this is opened by a browser Stripe
 * redirected -- it has no token and never will.
 *
 * Says nothing definitive about the outcome. Stripe redirects as soon as
 * the customer finishes, which can be before the webhook that actually
 * confirms payment; claiming success here and having the subscription
 * activate seconds later would be worse than saying nothing. The app is
 * watching its own subscription and tells them from the place that
 * knows.
 */
@SkipThrottle()
@Controller("customer/billing")
export class CheckoutReturnController {
  @Get("return")
  @Header("Content-Type", "text/html; charset=utf-8")
  billingReturn(@Query("status") status?: string): string {
    return checkoutReturnPage(status === "cancelled");
  }
}

@SkipThrottle()
@Controller("billing/webhooks")
export class WebhooksController {
  constructor(
    private readonly billingService: BillingService,
    private readonly stripe: StripeProvider,
    private readonly nowpayments: NowPaymentsProvider,
  ) {}

  @Post("stripe")
  async stripeWebhook(@Req() req: RawBodyRequest<Request>, @Headers("stripe-signature") signature?: string) {
    if (!req.rawBody || !signature) {
      throw new BadRequestException("Missing raw body or Stripe-Signature header");
    }

    const event = await this.stripe.constructEvent(req.rawBody, signature);

    if (event.type === "payment_intent.succeeded" || event.type === "payment_intent.payment_failed") {
      const intent = event.data.object as { metadata?: { paymentTransactionId?: string } };
      const transactionId = intent.metadata?.paymentTransactionId;
      if (transactionId) {
        if (event.type === "payment_intent.succeeded") {
          await this.billingService.confirmPayment(transactionId, event);
        } else {
          await this.billingService.markFailed(transactionId, event);
        }
      }
    }

    return { received: true };
  }

  @Post("nowpayments")
  async nowPaymentsWebhook(@Req() req: Request, @Headers("x-nowpayments-sig") signature?: string) {
    const body = req.body as { order_id?: string; payment_status?: string };
    if (!signature || !(await this.nowpayments.verifyIpnSignature(body, signature))) {
      throw new BadRequestException("Invalid or missing IPN signature");
    }

    const transactionId = body.order_id;
    if (!transactionId) {
      throw new BadRequestException("Missing order_id in IPN payload");
    }

    if (body.payment_status === "finished" || body.payment_status === "confirmed") {
      await this.billingService.confirmPayment(transactionId, body);
    } else if (body.payment_status === "failed" || body.payment_status === "expired") {
      await this.billingService.markFailed(transactionId, body);
    }

    return { received: true };
  }
}
