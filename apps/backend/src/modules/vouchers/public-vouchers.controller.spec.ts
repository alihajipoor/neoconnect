import { NotFoundException } from "@nestjs/common";
import { PublicVouchersController } from "./public-vouchers.controller";
import { VouchersService } from "./vouchers.service";

function buildVoucher(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "voucher-1",
    code: "ABCD2345EFGH",
    planId: "plan-1",
    plan: { id: "plan-1", name: "Pro", durationDays: 30 },
    maxRedemptions: 1,
    redeemedCount: 0,
    expiresAt: null,
    isActive: true,
    ...overrides,
  };
}

describe("PublicVouchersController", () => {
  let controller: PublicVouchersController;
  let prisma: { voucher: { findUnique: jest.Mock } };

  beforeEach(() => {
    prisma = { voucher: { findUnique: jest.fn() } };
    // The real service, not a stub. The behaviour under test is which
    // vouchers it refuses and how indistinguishably, and a stub would
    // just be asserting the mock.
    const service = new VouchersService(prisma as any, {} as any, {} as any);
    controller = new PublicVouchersController(service);
  });

  it("describes a usable voucher without requiring a login", async () => {
    // The whole reason this endpoint exists: someone handed a code by a
    // reseller should learn what it is worth before being asked to
    // create an account.
    prisma.voucher.findUnique.mockResolvedValue(buildVoucher());

    await expect(controller.preview("abcd2345efgh")).resolves.toEqual(
      expect.objectContaining({ code: "ABCD2345EFGH", plan: expect.objectContaining({ name: "Pro" }) }),
    );
  });

  it("gives one identical answer for unknown, spent, expired and deactivated", async () => {
    // Four different reasons, one response, on purpose. Distinguishing
    // them would turn this into a way to probe which codes were ever
    // issued -- "already used" confirms a real code, "not found" denies
    // one, and a reseller's whole stock could be mapped from the
    // difference.
    const cases: Array<[string, unknown]> = [
      ["unknown", null],
      ["spent", buildVoucher({ redeemedCount: 1, maxRedemptions: 1 })],
      ["expired", buildVoucher({ expiresAt: new Date(Date.now() - 60_000) })],
      ["deactivated", buildVoucher({ isActive: false })],
    ];

    const messages = new Set<string>();
    for (const [label, row] of cases) {
      prisma.voucher.findUnique.mockResolvedValue(row);
      await expect(controller.preview("ABCD2345EFGH")).rejects.toThrow(NotFoundException);
      try {
        await controller.preview("ABCD2345EFGH");
      } catch (error) {
        messages.add((error as Error).message);
      }
      expect(messages.size).toBe(1); // still one distinct message after `label`
    }
  });

  it("accepts a code however the customer typed it", async () => {
    // Codes travel through email, chat and handwriting. Case and
    // surrounding whitespace are not part of the secret.
    prisma.voucher.findUnique.mockResolvedValue(buildVoucher());

    await controller.preview("  abcd2345efgh  ");

    expect(prisma.voucher.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: "ABCD2345EFGH" } }),
    );
  });
});
