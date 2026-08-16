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
