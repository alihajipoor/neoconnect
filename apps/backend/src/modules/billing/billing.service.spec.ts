import { SubscriptionStatus } from "@prisma/client";
import { BillingService } from "./billing.service";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a payment does to a subscription's expiry.
 *
 * Split by whether the subscription has ever been active, because the
 * right answer differs and getting it wrong either robs the customer of
 * time they paid for or gives away a free term.
 */
describe("BillingService.confirmPayment expiry", () => {
  function build(subscription: Record<string, unknown>) {
    const prisma = {
      paymentTransaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: "txn-1",
          status: "PENDING",
          subscriptionId: "sub-1",
        }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue(subscription),
        update: jest.fn().mockResolvedValue({}),
      },
      protocolUser: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new BillingService(
      prisma as never,
      { create: jest.fn(), setEnabled: jest.fn(), provisionAll: jest.fn().mockResolvedValue({ created: [], revoked: [] }) } as never,
      {} as never, // stripe
      {} as never, // nowpayments
      {} as never, // plisio
      // ConfigService. These cases exercise renewal and expiry, none of
      // which reads config -- but the constructor takes it now.
      { get: jest.fn() } as never,
      // PaymentSettingsService. Only the purchase paths consult it, to
      // resolve which crypto provider is configured; these cases cover
      // renewal and expiry.
      { availableProviders: jest.fn().mockResolvedValue([]) } as never,
      { issueForPayment: jest.fn().mockResolvedValue({}) } as never,
      // subscriptions -- unused by these cases, which never redeem an
      // App Store purchase.
      {} as never,
    );
    return { service, prisma };
  }

  function newExpiryDays(prisma: { subscription: { update: jest.Mock } }) {
    const { data } = prisma.subscription.update.mock.calls[0][0] as { data: { expireAt: Date } };
    return Math.round((data.expireAt.getTime() - Date.now()) / DAY_MS);
  }

  // Reported after a real purchase: a 30-day plan activated as 60 days.
  // The self-serve flow creates the subscription PENDING with expireAt
  // already a full term out, and extending from that date handed over two
  // terms for one payment.
  it("gives exactly one term when a pending subscription is first paid for", async () => {
    const { service, prisma } = build({
      id: "sub-1",
      status: SubscriptionStatus.PENDING,
      // Provisional, written at creation, never paid for.
      expireAt: new Date(Date.now() + 30 * DAY_MS),
      plan: { durationDays: 30 },
    });

    await service.confirmPayment("txn-1", {});

    expect(newExpiryDays(prisma)).toBe(30);
  });

  it("extends from the existing expiry when an active subscription renews", async () => {
    // Time already paid for must not be thrown away just because the
    // customer renewed early.
    const { service, prisma } = build({
      id: "sub-1",
      status: SubscriptionStatus.ACTIVE,
      expireAt: new Date(Date.now() + 10 * DAY_MS),
      plan: { durationDays: 30 },
    });

    await service.confirmPayment("txn-1", {});

    expect(newExpiryDays(prisma)).toBe(40);
  });

  /** The stale-pending sweep cancelled the attempt, then the payment
   * landed anyway -- a Checkout tab paid seven hours later, a slow crypto
   * confirmation. The expiry is still the provisional one, a term out. */
  it("gives exactly one term when a payment lands on an unpaid attempt the sweep cancelled", async () => {
    const { service, prisma } = build({
      id: "sub-1",
      status: SubscriptionStatus.CANCELLED,
      expireAt: new Date(Date.now() + 30 * DAY_MS),
      plan: { durationDays: 30 },
    });
    (prisma as unknown as { paymentTransaction: { count: jest.Mock } }).paymentTransaction.count = jest
      .fn()
      .mockResolvedValue(0);

    await service.confirmPayment("txn-1", {});

    expect(newExpiryDays(prisma)).toBe(30);
    // This payment is already CONFIRMED when the question is asked, so it
    // must not count as the earlier one.
    expect(
      (prisma as unknown as { paymentTransaction: { count: jest.Mock } }).paymentTransaction.count,
    ).toHaveBeenCalledWith({ where: { subscriptionId: "sub-1", status: "CONFIRMED", id: { not: "txn-1" } } });
  });

  /** Cancelled by an operator or an account deletion after being paid
   * for: its remaining time was bought, and a renewal keeps it. */
  it("extends a cancelled subscription that was paid for before", async () => {
    const { service, prisma } = build({
      id: "sub-1",
      status: SubscriptionStatus.CANCELLED,
      expireAt: new Date(Date.now() + 10 * DAY_MS),
      plan: { durationDays: 30 },
    });
    (prisma as unknown as { paymentTransaction: { count: jest.Mock } }).paymentTransaction.count = jest
      .fn()
      .mockResolvedValue(1);

    await service.confirmPayment("txn-1", {});

    expect(newExpiryDays(prisma)).toBe(40);
  });

  it("starts a fresh term when an expired subscription is paid again", async () => {
    // Extending from a date in the past would sell time that has already
    // elapsed.
    const { service, prisma } = build({
      id: "sub-1",
      status: SubscriptionStatus.EXPIRED,
      expireAt: new Date(Date.now() - 5 * DAY_MS),
      plan: { durationDays: 30 },
    });

    await service.confirmPayment("txn-1", {});

    expect(newExpiryDays(prisma)).toBe(30);
  });
});

/** A success the provider reports after we had written the payment off.
 *
 * Stripe's payment_intent.payment_failed is one attempt, not the payment:
 * hosted Checkout lets the customer try another card on the same
 * PaymentIntent, and that success used to arrive at a FAILED row and be
 * ignored -- the customer charged, the subscription never activated, no
 * invoice, no log line. */
describe("BillingService.confirmPayment after a failure", () => {
  function build(status: string, updateCount = 1) {
    const prisma = {
      paymentTransaction: {
        findUnique: jest.fn().mockResolvedValue({ id: "txn-1", status, subscriptionId: "sub-1", provider: "STRIPE" }),
        updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sub-1",
          status: SubscriptionStatus.PENDING,
          expireAt: new Date(Date.now() + 30 * DAY_MS),
          plan: { durationDays: 30 },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      protocolUser: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const invoices = { issueForPayment: jest.fn().mockResolvedValue({}) };
    const service = new BillingService(
      prisma as never,
      { setEnabled: jest.fn(), provisionAll: jest.fn().mockResolvedValue({ created: [], revoked: [] }) } as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn() } as never,
      { availableProviders: jest.fn().mockResolvedValue([]) } as never,
      invoices as never,
      {} as never,
    );
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    return { service, prisma, invoices };
  }

  it("activates and invoices a payment that was marked FAILED and then succeeded", async () => {
    const { service, prisma, invoices } = build("FAILED");

    await service.confirmPayment("txn-1", {});

    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "txn-1", status: { in: ["PENDING", "FAILED"] } },
        data: expect.objectContaining({ status: "CONFIRMED" }),
      }),
    );
    expect(prisma.subscription.update.mock.calls[0][0].data.status).toBe("ACTIVE");
    expect(invoices.issueForPayment).toHaveBeenCalledWith("txn-1");
  });

  it("does nothing for a payment that is already confirmed", async () => {
    const { service, prisma, invoices } = build("CONFIRMED");

    await service.confirmPayment("txn-1", {});

    expect(prisma.paymentTransaction.updateMany).not.toHaveBeenCalled();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(invoices.issueForPayment).not.toHaveBeenCalled();
  });

  /** Two deliveries of the same success, racing: both read PENDING. Only
   * the one whose conditional write lands may renew, or one payment buys
   * two terms. */
  it("renews only once when a duplicate delivery loses the race", async () => {
    const { service, prisma, invoices } = build("PENDING", 0);

    await service.confirmPayment("txn-1", {});

    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(invoices.issueForPayment).not.toHaveBeenCalled();
  });
});

describe("BillingService.markFailed", () => {
  it("only ever fails a PENDING payment, in one conditional write", async () => {
    const prisma = { paymentTransaction: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    const service = new BillingService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.markFailed("txn-1", {});

    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "txn-1", status: "PENDING" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });
});

/** The money has moved by the time provisioning runs. A provisioning
 * failure must not also skip the invoice -- the customer is owed one
 * whether or not a node was reachable. */
describe("BillingService.confirmPayment when provisioning fails", () => {
  it("still extends the subscription and issues the invoice", async () => {
    const prisma = {
      paymentTransaction: {
        findUnique: jest.fn().mockResolvedValue({ id: "txn-1", status: "PENDING", subscriptionId: "sub-1", provider: "STRIPE" }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sub-1",
          status: SubscriptionStatus.ACTIVE,
          expireAt: new Date(Date.now() + DAY_MS),
          plan: { durationDays: 30 },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      protocolUser: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const invoices = { issueForPayment: jest.fn().mockResolvedValue({}) };
    const service = new BillingService(
      prisma as never,
      {
        setEnabled: jest.fn(),
        provisionAll: jest.fn().mockRejectedValue(new Error("The Pro plan's selected routes are all unavailable")),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn() } as never,
      { availableProviders: jest.fn().mockResolvedValue([]) } as never,
      invoices as never,
      {} as never,
    );

    await expect(service.confirmPayment("txn-1", {})).resolves.toBeUndefined();

    expect(prisma.subscription.update).toHaveBeenCalled();
    expect(invoices.issueForPayment).toHaveBeenCalledWith("txn-1");
  });
});
