import { WebhooksController } from "./webhooks.controller";

/** Which Stripe events end a payment, and which do not.
 *
 * payment_intent.payment_failed is one attempt. In hosted Checkout a
 * declined card or a failed 3-D Secure check leaves the customer on the
 * same page, free to try another card on the same PaymentIntent. Treating
 * it as the end of the payment is what made the success that followed a
 * no-op -- a customer charged and given nothing. */
describe("WebhooksController.stripeWebhook", () => {
  function build(type: string, metadata: Record<string, string> | undefined = { paymentTransactionId: "txn-1" }) {
    const billing = { confirmPayment: jest.fn(), markFailed: jest.fn() };
    const stripe = {
      constructEvent: jest.fn().mockResolvedValue({ type, data: { object: { metadata } } }),
    };
    const controller = new WebhooksController(billing as never, stripe as never, {} as never, {} as never);
    jest.spyOn(controller["logger"], "log").mockImplementation(() => undefined);
    const call = () => controller.stripeWebhook({ rawBody: Buffer.from("{}") } as never, "sig");
    return { billing, call };
  }

  it("confirms on payment_intent.succeeded", async () => {
    const { billing, call } = build("payment_intent.succeeded");

    await call();

    expect(billing.confirmPayment).toHaveBeenCalledWith("txn-1", expect.anything());
  });

  it("leaves the payment open on payment_intent.payment_failed", async () => {
    const { billing, call } = build("payment_intent.payment_failed");

    await expect(call()).resolves.toEqual({ received: true });

    expect(billing.markFailed).not.toHaveBeenCalled();
    expect(billing.confirmPayment).not.toHaveBeenCalled();
  });

  it.each(["checkout.session.expired", "payment_intent.canceled"])("fails the payment on %s", async (type) => {
    const { billing, call } = build(type);

    await call();

    expect(billing.markFailed).toHaveBeenCalledWith("txn-1", expect.anything());
  });

  it("ignores an event that is not ours", async () => {
    const { billing, call } = build("payment_intent.succeeded", {});

    await expect(call()).resolves.toEqual({ received: true });

    expect(billing.confirmPayment).not.toHaveBeenCalled();
  });
});
