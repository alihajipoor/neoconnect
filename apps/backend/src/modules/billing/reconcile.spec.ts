import { BadRequestException } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { PlisioProvider } from "./providers/plisio.provider";

/** The admin safety net for a lost webhook.
 *
 * It had two branches -- Stripe, and everything else sent to NowPayments
 * -- and neither worked on the paths customers use: a Stripe Checkout
 * payment records the session id (cs_...), which paymentIntents.retrieve
 * refuses, and a Plisio payment was looked up at NowPayments. */
describe("BillingService.reconcile", () => {
  function build(transaction: { provider: string; providerRef: string; status?: string }) {
    const row = { id: "txn-1", status: "PENDING", subscriptionId: null, ...transaction };
    const prisma = {
      paymentTransaction: {
        findUnique: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const stripe = { retrieveCheckoutSession: jest.fn(), retrievePaymentIntent: jest.fn() };
    const nowpayments = { getPaymentStatus: jest.fn() };
    // classify() is the real one: reconcile must read a status exactly as
    // the callback does.
    const realPlisio = new PlisioProvider({ get: jest.fn() } as never, {} as never);
    const plisio = { getOperationStatus: jest.fn(), classify: (s: string) => realPlisio.classify(s) };
    const service = new BillingService(
      prisma as never,
      {} as never,
      stripe as never,
      nowpayments as never,
      plisio as never,
      { get: jest.fn() } as never,
      {} as never,
      { issueForPayment: jest.fn() } as never,
      {} as never,
    );
    const confirm = jest.spyOn(service, "confirmPayment").mockResolvedValue(undefined);
    const fail = jest.spyOn(service, "markFailed").mockResolvedValue(undefined);
    return { service, stripe, nowpayments, plisio, confirm, fail };
  }

  it("confirms a paid Stripe Checkout session by its session id", async () => {
    const { service, stripe, confirm } = build({ provider: "STRIPE", providerRef: "cs_test_123" });
    stripe.retrieveCheckoutSession.mockResolvedValue({ payment_status: "paid", status: "complete" });

    await service.reconcile("txn-1");

    expect(stripe.retrieveCheckoutSession).toHaveBeenCalledWith("cs_test_123");
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith("txn-1", expect.anything());
  });

  it("fails an expired Checkout session and leaves an open one alone", async () => {
    const { service, stripe, confirm, fail } = build({ provider: "STRIPE", providerRef: "cs_test_123" });
    stripe.retrieveCheckoutSession.mockResolvedValueOnce({ payment_status: "unpaid", status: "expired" });
    await service.reconcile("txn-1");
    expect(fail).toHaveBeenCalledTimes(1);

    stripe.retrieveCheckoutSession.mockResolvedValueOnce({ payment_status: "unpaid", status: "open" });
    await service.reconcile("txn-1");
    expect(fail).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("still reconciles a PaymentIntent reference", async () => {
    const { service, stripe, confirm } = build({ provider: "STRIPE", providerRef: "pi_123" });
    stripe.retrievePaymentIntent.mockResolvedValue({ status: "succeeded" });

    await service.reconcile("txn-1");

    expect(confirm).toHaveBeenCalled();
  });

  it.each([
    ["completed", "confirm"],
    ["expired", "fail"],
    ["mismatch", "neither"],
    ["pending", "neither"],
  ])("asks Plisio, not NowPayments, about a Plisio payment (%s -> %s)", async (status, expected) => {
    const { service, plisio, nowpayments, confirm, fail } = build({ provider: "PLISIO", providerRef: "plisio-txn" });
    plisio.getOperationStatus.mockResolvedValue(status);

    await service.reconcile("txn-1");

    expect(plisio.getOperationStatus).toHaveBeenCalledWith("plisio-txn");
    expect(nowpayments.getPaymentStatus).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(expected === "confirm" ? 1 : 0);
    expect(fail).toHaveBeenCalledTimes(expected === "fail" ? 1 : 0);
  });

  it("reconciles a payment that was marked FAILED, since it may have been paid after all", async () => {
    const { service, stripe, confirm } = build({ provider: "STRIPE", providerRef: "cs_test_1", status: "FAILED" });
    stripe.retrieveCheckoutSession.mockResolvedValue({ payment_status: "paid", status: "complete" });

    await service.reconcile("txn-1");

    expect(confirm).toHaveBeenCalled();
  });

  describe("PlisioProvider.getOperationStatus", () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });
    const provider = () =>
      new PlisioProvider({ get: jest.fn() } as never, { plisio: jest.fn().mockResolvedValue({ apiKey: "k" }) } as never);

    it("reads the invoice's status from GET /operations/{txn_id}", async () => {
      const fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: "success", data: { status: "completed" } }),
      });
      global.fetch = fetch as never;

      await expect(provider().getOperationStatus("abc123")).resolves.toBe("completed");
      expect(String(fetch.mock.calls[0][0])).toMatch(/\/operations\/abc123\?api_key=k$/);
    });

    it("throws rather than guessing when Plisio does not answer with a status", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ status: "error", data: { message: "not found" } }),
      }) as never;
      const p = provider();
      jest.spyOn(p["logger"], "error").mockImplementation(() => undefined);

      await expect(p.getOperationStatus("abc123")).rejects.toThrow(/Could not ask Plisio/);
    });
  });

  it("refuses a provider it has nothing to ask", async () => {
    const { service, nowpayments } = build({ provider: "APPLE_IAP", providerRef: "2000000123" });

    await expect(service.reconcile("txn-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(nowpayments.getPaymentStatus).not.toHaveBeenCalled();
  });
});
