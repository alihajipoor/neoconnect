/* eslint-disable @typescript-eslint/require-await -- Prisma stand-ins
   match the client's async signatures. */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ResellersService } from "../resellers/resellers.service";
import { VouchersService } from "./vouchers.service";

/** A voucher for a plan the operator has since unticked "Active".
 *
 * redeem() counted the code and wrote the redemption, then
 * subscriptionsService.create threw "Plan is not active": the one-use
 * code was spent on nothing, the retry said it was not valid, and the
 * reseller who paid a token for it could no longer revoke it. Resellers
 * could also keep minting codes for such a plan. */

const voucher = (planActive: boolean) => ({
  id: "v-1",
  code: "ABCD2345EFGH",
  planId: "plan-old",
  isActive: true,
  expiresAt: null,
  maxRedemptions: 1,
  redeemedCount: 0,
  plan: { id: "plan-old", name: "Old", isActive: planActive },
});

function vouchers(planActive: boolean) {
  const prisma = {
    voucher: {
      findUnique: jest.fn(async () => voucher(planActive)),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    voucherRedemption: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: "red-1" })),
      update: jest.fn(async () => ({})),
    },
  };
  const subscriptions = { create: jest.fn(async () => ({ id: "sub-1" })) };
  const protocolUsers = { provisionAll: jest.fn(async () => ({ created: [] })) };
  const service = new VouchersService(prisma as never, subscriptions as never, protocolUsers as never);
  return { service, prisma, subscriptions };
}

describe("redeeming a voucher whose plan is no longer active", () => {
  it("refuses before the code is counted or the redemption written", async () => {
    const { service, prisma, subscriptions } = vouchers(false);
    await expect(service.redeem("customer-1", "ABCD2345EFGH")).rejects.toThrow(/no longer offered/);
    await expect(service.redeem("customer-1", "ABCD2345EFGH")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.voucher.updateMany).not.toHaveBeenCalled();
    expect(prisma.voucherRedemption.create).not.toHaveBeenCalled();
    expect(subscriptions.create).not.toHaveBeenCalled();
  });

  it("is not offered by the public preview either", async () => {
    const { service } = vouchers(false);
    await expect(service.preview("ABCD2345EFGH")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("still redeems a voucher whose plan is active", async () => {
    const { service, prisma, subscriptions } = vouchers(true);
    await service.redeem("customer-1", "ABCD2345EFGH");
    expect(prisma.voucher.updateMany).toHaveBeenCalledTimes(1);
    expect(subscriptions.create).toHaveBeenCalledWith({ customerId: "customer-1", planId: "plan-old" });
    expect((await service.preview("ABCD2345EFGH")).code).toBe("ABCD2345EFGH");
  });
});

describe("a reseller and a retired plan", () => {
  function resellers(planActive: boolean) {
    const tx = {
      resellerTokenBalance: { updateMany: jest.fn(async () => ({ count: 1 })) },
      voucher: { findUnique: jest.fn(async () => null), create: jest.fn(async () => ({ id: "v-2", code: "X" })) },
    };
    const prisma = {
      subscriptionPlan: {
        findUnique: jest.fn(async () => ({ id: "plan-old", name: "Old", isActive: planActive })),
        findMany: jest.fn(async () => [{ id: "plan-old", name: "Old", priceUsd: "5", durationDays: 30, isActive: false }]),
      },
      resellerTokenBalance: { findMany: jest.fn(async () => [{ planId: "plan-old", balance: 3 }]) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const service = new ResellersService(prisma as never, {} as never, {} as never, {} as never);
    return { service, prisma, tx };
  }

  it("cannot mint a code for it, and keeps the token", async () => {
    const { service, tx } = resellers(false);
    await expect(service.generate("reseller-1", "plan-old")).rejects.toThrow(/no longer offered/);
    expect(tx.resellerTokenBalance.updateMany).not.toHaveBeenCalled();
    expect(tx.voucher.create).not.toHaveBeenCalled();
  });

  it("still sees the balance, marked as a plan that is not offered", async () => {
    const { service, prisma } = resellers(false);
    expect(await service.myBalances("reseller-1")).toEqual([
      { plan: { id: "plan-old", name: "Old", priceUsd: "5", durationDays: 30, isActive: false }, balance: 3 },
    ]);
    expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ isActive: true }) }),
    );
  });
});
