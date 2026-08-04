import { SubscriptionStatus } from "@prisma/client";
import { SubscriptionsService } from "./subscriptions.service";
import { PrismaService } from "../../prisma/prisma.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";

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
    // The protocol-user side is not exercised by these tests -- they
    // cover status-at-creation, not provisioning -- so a stub keeps the
    // constructor honest without pretending to test what it does.
    const protocolUsers = {
      setEnabled: jest.fn(),
      remove: jest.fn(),
    } as unknown as ProtocolUsersService;
    return {
      prisma,
      service: new SubscriptionsService(prisma as unknown as PrismaService, protocolUsers),
    };
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

/** Reusing an unpaid attempt, rather than starting a fresh one on every
 * press of a payment button. */
describe("SubscriptionsService.createOrReusePending", () => {
  const PLAN = { id: "plan-1", isActive: true, durationDays: 30, dataCapBytes: 100n };

  function build(existingPending: { id: string } | null = null) {
    const prisma = {
      customer: { findUnique: jest.fn().mockResolvedValue({ id: "cust-1" }) },
      subscriptionPlan: { findUnique: jest.fn().mockResolvedValue(PLAN) },
      subscription: {
        findFirst: jest.fn().mockResolvedValue(existingPending),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "sub-1", ...data })),
        update: jest.fn().mockImplementation(({ where }) => Promise.resolve({ id: where.id })),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
    };
    // The protocol-user side is not exercised by these tests -- they
    // cover status-at-creation, not provisioning -- so a stub keeps the
    // constructor honest without pretending to test what it does.
    const protocolUsers = {
      setEnabled: jest.fn(),
      remove: jest.fn(),
    } as unknown as ProtocolUsersService;
    return {
      prisma,
      service: new SubscriptionsService(prisma as unknown as PrismaService, protocolUsers),
    };
  }

  // The app calls this before every payment attempt, so pressing Card and
  // then Crypto -- or simply retrying after a failure -- used to leave one
  // dead subscription behind per press.
  it("reuses an unpaid attempt at the same plan instead of creating another", async () => {
    const { service, prisma } = build({ id: "pending-1" });

    const result = await service.createOrReusePending("cust-1", "plan-1");

    expect(prisma.subscription.create).not.toHaveBeenCalled();
    expect(result.id).toBe("pending-1");
  });

  it("refreshes a reused attempt against the plan as it stands now", async () => {
    const { service, prisma } = build({ id: "pending-1" });

    await service.createOrReusePending("cust-1", "plan-1");

    // It was never paid for, so it should not carry terms captured
    // whenever the abandoned attempt happened.
    const { data } = prisma.subscription.update.mock.calls[0][0] as {
      data: { dataCapBytes: number; expireAt: Date };
    };
    expect(data.dataCapBytes).toBe(PLAN.dataCapBytes);
    expect(data.expireAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("creates a PENDING subscription when there is nothing to reuse", async () => {
    const { service, prisma } = build(null);

    const result = await service.createOrReusePending("cust-1", "plan-1");

    expect(prisma.subscription.create).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(SubscriptionStatus.PENDING);
  });

  it("scopes reuse to one plan, since another plan is a different purchase", async () => {
    const { service, prisma } = build(null);

    await service.createOrReusePending("cust-1", "plan-1");

    expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: "cust-1", planId: "plan-1", status: SubscriptionStatus.PENDING },
      }),
    );
  });

  it("cancels only PENDING rows past the cutoff", async () => {
    const { service, prisma } = build(null);

    const count = await service.cancelStalePending(6 * 60 * 60 * 1000);

    expect(count).toBe(3);
    const { where } = prisma.subscription.updateMany.mock.calls[0][0] as {
      where: { status: SubscriptionStatus; createdAt: { lt: Date } };
    };
    expect(where.status).toBe(SubscriptionStatus.PENDING);
    // Crypto can sit unconfirmed a long time; cancelling one still in
    // flight is far worse than leaving a dead row an extra hour.
    expect(where.createdAt.lt.getTime()).toBeLessThan(Date.now());
  });
});
