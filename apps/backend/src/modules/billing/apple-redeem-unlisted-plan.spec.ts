/* eslint-disable @typescript-eslint/require-await -- Prisma stand-ins
   match the client's async signatures. */
import { BillingService } from "./billing.service";
import { verifyAppleTransaction } from "./providers/apple-iap.provider";

// The signature check has its own spec (providers/apple-iap.provider
// .spec.ts). What is under test here is what happens after a transaction
// has verified: which plan it may be turned into.
jest.mock("./providers/apple-iap.provider", () => ({ verifyAppleTransaction: jest.fn() }));

/** An App Store purchase and a plan that is not on sale.
 *
 * Redeeming asked only whether the product's plan was active. A plan
 * that works but is not offered -- active, not purchasable -- is no more
 * a thing to sell on iPhone than anywhere else, so a new purchase of one
 * gets the answer an inactive plan gets. A purchase already redeemed is
 * a different question: taking a plan off sale does not take it away
 * from whoever bought it, so the restore still answers. */

type Flags = { isActive: boolean; isPurchasable: boolean };

function build(flags: Flags, already: { customerId: string; subscriptionId: string } | null = null) {
  (verifyAppleTransaction as jest.Mock).mockReturnValue({
    transactionId: "apple-txn-1",
    originalTransactionId: "apple-txn-1",
    productId: "product.pro",
    bundleId: "app.bundle",
    environment: "Production",
    purchaseDate: new Date(),
  });

  const prisma = {
    subscriptionPlan: {
      findUnique: jest.fn(async () => ({ id: "plan-1", priceUsd: "6.99", durationDays: 30, dataCapBytes: null, ...flags })),
    },
    paymentTransaction: {
      // Asked twice: once by Apple's transaction id (has this purchase
      // been redeemed?) and once by our own id, from confirmPayment.
      findUnique: jest.fn(async ({ where }: { where: { id?: string } }) =>
        where.id ? { id: "txn-1", status: "PENDING", subscriptionId: "sub-1", provider: "APPLE_IAP" } : already,
      ),
      create: jest.fn(async () => ({ id: "txn-1" })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    subscription: {
      findUnique: jest.fn(async () => ({
        id: "sub-1",
        status: "PENDING",
        expireAt: new Date(),
        plan: { durationDays: 30, dataCapBytes: null },
      })),
      update: jest.fn(async () => ({})),
    },
    protocolUser: { findMany: jest.fn(async () => []) },
  };
  const subscriptions = { createOrReusePending: jest.fn(async () => ({ id: "sub-1" })) };
  const service = new BillingService(
    prisma as never,
    { setEnabled: jest.fn(), provisionAll: jest.fn(async () => ({ created: [{}], revoked: [] })) } as never,
    {} as never, // stripe
    {} as never, // nowpayments
    {} as never, // plisio
    { get: jest.fn((key: string) => (key === "APPLE_BUNDLE_ID" ? "app.bundle" : undefined)) } as never,
    { availableProviders: jest.fn(async () => []) } as never,
    { issueForPayment: jest.fn(async () => ({})) } as never,
    subscriptions as never,
  );
  const errors = jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
  return { service, prisma, subscriptions, errors };
}

describe("BillingService.redeemApplePurchase and the plan's flags", () => {
  it("grants a plan that is active and on sale", async () => {
    const { service, prisma, subscriptions } = build({ isActive: true, isPurchasable: true });

    await expect(service.redeemApplePurchase("cust-1", "signed")).resolves.toEqual({
      subscriptionId: "sub-1",
      alreadyRedeemed: false,
    });
    expect(subscriptions.createOrReusePending).toHaveBeenCalledWith("cust-1", "plan-1");
    expect(prisma.paymentTransaction.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a new purchase of a plan that is active but not on sale, and grants nothing", async () => {
    const { service, prisma, subscriptions, errors } = build({ isActive: true, isPurchasable: false });

    await expect(service.redeemApplePurchase("cust-1", "signed")).rejects.toThrow(
      "That purchase could not be matched to a plan",
    );
    expect(subscriptions.createOrReusePending).not.toHaveBeenCalled();
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled();
    // Apple has already charged for it, so this is somebody's job today.
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("product.pro"));
  });

  it("answers it exactly as it answers an inactive plan", async () => {
    const reply = async (flags: Flags) =>
      build(flags)
        .service.redeemApplePurchase("cust-1", "signed")
        .then(
          () => "granted",
          (err: { message: string; getStatus(): number }) => `${err.getStatus()} ${err.message}`,
        );

    expect(await reply({ isActive: true, isPurchasable: false })).toBe(
      await reply({ isActive: false, isPurchasable: true }),
    );
  });

  it("still restores a purchase made before the plan was taken off sale", async () => {
    const { service, subscriptions } = build(
      { isActive: true, isPurchasable: false },
      { customerId: "cust-1", subscriptionId: "sub-old" },
    );

    await expect(service.redeemApplePurchase("cust-1", "signed")).resolves.toEqual({
      subscriptionId: "sub-old",
      alreadyRedeemed: true,
    });
    expect(subscriptions.createOrReusePending).not.toHaveBeenCalled();
  });
});
