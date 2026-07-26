import { SubscriptionStatus } from "@prisma/client";
import { SubscriptionsService } from "./subscriptions.service";
import { PrismaService } from "../../prisma/prisma.service";

/** The property under test is the one that decides whether someone who
 * never paid looks like a customer. */
describe("SubscriptionsService.create", () => {
  function build() {
    const prisma = {
      customer: { findUnique: jest.fn().mockResolvedValue({ id: "cust-1" }) },
      subscriptionPlan: {
        findUnique: jest.fn().mockResolvedValue({
          id: "plan-1",
          isActive: true,
          durationDays: 30,
          dataCapBytes: 100n,
        }),
      },
      subscription: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "sub-1", ...data })),
      },
    };
    return { prisma, service: new SubscriptionsService(prisma as unknown as PrismaService) };
  }

  it("starts PENDING when the caller says so, so an unpaid plan is not a customer", async () => {
    // The self-serve purchase flow creates the subscription before the
    // payment is even attempted. Left ACTIVE, someone who picks a plan and
    // closes the payment window is indistinguishable in the panel from
    // someone who paid -- and their expiry clock starts running.
    const { service, prisma } = build();

    await service.create({ customerId: "cust-1", planId: "plan-1" } as never, SubscriptionStatus.PENDING);

    expect(prisma.subscription.create.mock.calls[0][0].data.status).toBe(SubscriptionStatus.PENDING);
  });

  it("still defaults to ACTIVE, because trials and admin-created ones are live immediately", async () => {
    const { service, prisma } = build();

    await service.create({ customerId: "cust-1", planId: "plan-1" } as never);

    expect(prisma.subscription.create.mock.calls[0][0].data.status).toBe(SubscriptionStatus.ACTIVE);
  });
});
