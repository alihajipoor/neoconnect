/* eslint-disable @typescript-eslint/require-await -- Prisma stand-ins
   match the client's async signatures. */
import { ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import { VouchersService } from "./vouchers.service";
import { restrictedVoucherCaller } from "../customer/customer.controller";
import { attachRelayContext } from "../../common/relay/relay-arrival";

/** Vouchers over the relay, or for an account whose address is
 * unconfirmed (docs/relay-last-resort.md, F1 and R5.1).
 *
 * An unverified account costs nothing to make, and an operator's code can
 * be unlimited: one leaked multi-use Ultimate code and a farm of relay
 * sign-ups would be unlimited free Ultimate. So such a caller may redeem
 * only a single-use code for a relay-only plan -- what a reseller sells
 * -- and anything else is refused before the code is touched. */

function setup(code: { maxRedemptions: number | null; relayOnly: boolean }) {
  const voucher = {
    id: "v-1",
    code: "ABCD2345EFGH",
    planId: "plan-1",
    isActive: true,
    expiresAt: null,
    maxRedemptions: code.maxRedemptions,
    redeemedCount: 0,
    plan: { id: "plan-1", name: "Ultimate", isActive: true, relayOnly: code.relayOnly },
  };
  const prisma = {
    voucher: {
      findUnique: jest.fn(async () => voucher),
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

async function refusalCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err instanceof ForbiddenException ? (err.getResponse() as { code?: string }).code : String(err);
  }
}

describe("vouchers for a restricted caller", () => {
  it.each([
    ["a multi-use Ultimate code", { maxRedemptions: 50, relayOnly: true }],
    ["an unlimited Ultimate code", { maxRedemptions: null, relayOnly: true }],
    ["a single-use code for another plan", { maxRedemptions: 1, relayOnly: false }],
  ])("refuses %s and does not spend it", async (_name, code) => {
    const { service, prisma, subscriptions } = setup(code);
    expect(await refusalCode(service.redeem("customer-1", "ABCD2345EFGH", { restricted: true }))).toBe(
      "VOUCHER_NOT_ALLOWED",
    );
    expect(prisma.voucher.updateMany).not.toHaveBeenCalled();
    expect(prisma.voucherRedemption.create).not.toHaveBeenCalled();
    expect(subscriptions.create).not.toHaveBeenCalled();
    expect(await refusalCode(service.preview("ABCD2345EFGH", { restricted: true }))).toBe("VOUCHER_NOT_ALLOWED");
  });

  it("redeems a single-use Ultimate code", async () => {
    const { service, prisma, subscriptions } = setup({ maxRedemptions: 1, relayOnly: true });
    expect((await service.preview("ABCD2345EFGH", { restricted: true })).code).toBe("ABCD2345EFGH");
    await service.redeem("customer-1", "ABCD2345EFGH", { restricted: true });
    expect(prisma.voucher.updateMany).toHaveBeenCalledTimes(1);
    expect(subscriptions.create).toHaveBeenCalledWith({ customerId: "customer-1", planId: "plan-1" });
  });

  it("leaves everyone else's vouchers as they were", async () => {
    const { service, subscriptions } = setup({ maxRedemptions: 50, relayOnly: false });
    await service.redeem("customer-1", "ABCD2345EFGH");
    expect(subscriptions.create).toHaveBeenCalledTimes(1);
  });
});

/** Who is held to those codes: anyone over the relay, and an account the
 * guard found limited (relay-unverified) or could not say -- not an
 * account that is merely unverified from before verification existed. */
describe("a restricted voucher caller", () => {
  const normal = () => ({ headers: {} }) as unknown as Request;
  const relay = () => {
    const req = normal();
    attachRelayContext(req, { box: "ir-a", asn: 64500, region: "IR", ip: "192.0.2.10", ipKey: "relay:k" });
    return req;
  };
  const caller = (limited?: boolean) => ({ sub: "customer-1", email: "c@example.com", limited });

  it("is anyone over the relay", () => {
    expect(restrictedVoucherCaller(caller(false), relay())).toBe(true);
  });

  it("is a limited account, or one the guard did not judge, on any route", () => {
    expect(restrictedVoucherCaller(caller(true), normal())).toBe(true);
    expect(restrictedVoucherCaller(caller(undefined), normal())).toBe(true);
  });

  it("is not an account that is not limited, on the normal routes", () => {
    expect(restrictedVoucherCaller(caller(false), normal())).toBe(false);
  });
});
