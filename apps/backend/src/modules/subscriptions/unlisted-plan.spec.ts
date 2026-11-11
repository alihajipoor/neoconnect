/* eslint-disable @typescript-eslint/require-await -- Prisma stand-ins
   match the client's async signatures. */
import { BadRequestException } from "@nestjs/common";
import { SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { VouchersService } from "../vouchers/vouchers.service";
import { SubscriptionsService } from "./subscriptions.service";

/** A plan that works but is not on sale: active, not purchasable.
 *
 * The trial is one, and so is any plan staff hand out. The plan list a
 * customer is shown leaves such a plan out, but the call that starts a
 * purchase asked only whether the plan was active, and the id it is
 * given comes from the caller. So a purchase could be started of a plan
 * nobody had offered.
 *
 * Two halves, and the second matters as much as the first: the
 * customer's own purchase is refused, and everything staff do with the
 * same plan carries on working. */

type Flags = { isActive: boolean; isPurchasable: boolean };

const ON_SALE: Flags = { isActive: true, isPurchasable: true };
const UNLISTED: Flags = { isActive: true, isPurchasable: false };
const RETIRED: Flags = { isActive: false, isPurchasable: true };

function build(flags: Flags, existingPending: { id: string } | null = null) {
  const plan = { id: "plan-1", name: "Plan", durationDays: 30, dataCapBytes: 100n, ...flags };
  const prisma = {
    customer: { findUnique: jest.fn(async () => ({ id: "cust-1" })) },
    subscriptionPlan: { findUnique: jest.fn(async () => plan) },
    subscription: {
      findFirst: jest.fn(async () => existingPending),
      findUnique: jest.fn(async () => ({ id: "sub-1", planId: "plan-0" })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sub-1", ...data })),
      update: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
    },
  };
  const protocolUsers = { provisionAll: jest.fn(async () => ({ created: [], revoked: [], failed: [] })) };
  const service = new SubscriptionsService(
    prisma as unknown as PrismaService,
    protocolUsers as unknown as ProtocolUsersService,
  );
  return { service, prisma, protocolUsers };
}

describe("a customer starting a purchase (POST /customer/subscriptions)", () => {
  it("takes a plan that is active and on sale", async () => {
    const { service, prisma } = build(ON_SALE);

    const result = await service.createOrReusePending("cust-1", "plan-1");

    expect(prisma.subscription.create).toHaveBeenCalledTimes(1);
    expect((result as { status: SubscriptionStatus }).status).toBe(SubscriptionStatus.PENDING);
  });

  it("refuses a plan that is active but not on sale, and writes nothing", async () => {
    const { service, prisma } = build(UNLISTED);

    await expect(service.createOrReusePending("cust-1", "plan-1")).rejects.toThrow(
      "Plan is not available for purchase",
    );
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    expect(prisma.subscription.create).not.toHaveBeenCalled();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it("refuses it the way it refuses an inactive plan: a 400, not a 404 or a 500", async () => {
    const unlisted = build(UNLISTED).service.createOrReusePending("cust-1", "plan-1");
    const retired = build(RETIRED).service.createOrReusePending("cust-1", "plan-1");

    await expect(unlisted).rejects.toBeInstanceOf(BadRequestException);
    await expect(retired).rejects.toBeInstanceOf(BadRequestException);
  });

  /** An attempt left over from when the plan was on sale. Reusing it
   * would refresh its dates and hand it back as something to pay for. */
  it("does not revive an unpaid attempt at a plan since taken off sale", async () => {
    const { service, prisma } = build(UNLISTED, { id: "pending-1" });

    await expect(service.createOrReusePending("cust-1", "plan-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });
});

describe("staff giving out a plan that is not on sale", () => {
  it("assigns it (POST /subscriptions/assign) and provisions it", async () => {
    const { service, prisma, protocolUsers } = build(UNLISTED);

    await service.assign("cust-1", "plan-1");

    const { data } = prisma.subscription.create.mock.calls[0][0];
    expect(data).toMatchObject({ customerId: "cust-1", planId: "plan-1", status: SubscriptionStatus.ACTIVE });
    expect(protocolUsers.provisionAll).toHaveBeenCalledWith("sub-1");
  });

  it("moves a subscription onto it (PATCH /subscriptions/:id/plan)", async () => {
    const { service, prisma, protocolUsers } = build(UNLISTED);

    await service.changePlan("sub-1", "plan-1");

    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sub-1" }, data: expect.objectContaining({ planId: "plan-1" }) }),
    );
    expect(protocolUsers.provisionAll).toHaveBeenCalledWith("sub-1");
  });

  /** `create` is what the trial at sign-up, a referral reward and the
   * operator's own "create subscription" all call. The trial plan is
   * unlisted on purpose, so a check here would stop every new trial. */
  it("creates a subscription on it (POST /subscriptions, the trial, a referral reward)", async () => {
    const { service, prisma } = build(UNLISTED);

    await service.create({ customerId: "cust-1", planId: "plan-1" } as never);

    expect(prisma.subscription.create).toHaveBeenCalledTimes(1);
  });

  /** A plan issued only by voucher is unlisted by definition. Wired to
   * the real SubscriptionsService, since the check that could break this
   * would live there and a stand-in would not notice. */
  it("redeems a voucher staff or a reseller minted for it", async () => {
    const { service: subscriptions, prisma: subscriptionsPrisma, protocolUsers } = build(UNLISTED);
    const voucherPrisma = {
      ...subscriptionsPrisma,
      voucher: {
        findUnique: jest.fn(async () => ({
          id: "v-1",
          code: "ABCD2345EFGH",
          planId: "plan-1",
          isActive: true,
          expiresAt: null,
          maxRedemptions: 1,
          redeemedCount: 0,
          plan: { isActive: true, relayOnly: false },
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      voucherRedemption: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: "red-1" })),
        update: jest.fn(async () => ({})),
      },
    };
    const vouchers = new VouchersService(voucherPrisma as never, subscriptions, protocolUsers as never);

    const result = await vouchers.redeem("cust-1", "ABCD2345EFGH");

    expect(result.subscription).toMatchObject({ planId: "plan-1", status: SubscriptionStatus.ACTIVE });
    expect(voucherPrisma.voucherRedemption.update).toHaveBeenCalledWith({
      where: { id: "red-1" },
      data: { subscriptionId: "sub-1" },
    });
  });
});
