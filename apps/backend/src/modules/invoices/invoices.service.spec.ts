import { BadRequestException, NotFoundException } from "@nestjs/common";
import { cursoredFindMany } from "../../../test/cursored";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../../prisma/prisma.service";

/** Invoices are financial records, so the properties worth pinning down
 * are the ones that would quietly corrupt the books: duplicate numbers,
 * duplicate invoices for one payment, and history changing under you. */
describe("InvoicesService", () => {
  let seq: number;

  function build(overrides: Record<string, unknown> = {}) {
    seq = 0;
    const prisma = {
      invoice: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        // Cursor-aware -- markOverdue reads in batches. Overridable per
        // test through `overrides`, but the default has to advance.
        findMany: cursoredFindMany<{ id: string }>([]),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "inv-1", ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "inv-1", ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      paymentTransaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: "tx-1",
          customerId: "cust-1",
          subscriptionId: "sub-1",
          amountUsd: "9.99",
          currency: "usd",
          createdAt: new Date("2026-01-01"),
          subscription: {
            startAt: new Date("2026-01-01"),
            expireAt: new Date("2026-02-01"),
            plan: { name: "Pro" },
          },
          ...overrides,
        }),
      },
      customer: { findUnique: jest.fn().mockResolvedValue({ id: "cust-1", email: "c@example.com" }) },
      $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([{ nextval: BigInt(++seq) }])),
    };
    // Mail is best-effort and never affects the outcome, so it is stubbed
    // rather than asserted here -- what matters is the invoice, not the
    // notification about it.
    const emailService = { sendMail: jest.fn().mockResolvedValue(true) };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    return {
      prisma,
      emailService,
      service: new InvoicesService(
        prisma as unknown as PrismaService,
        emailService as never,
        config as never,
        // Signs the emailed invoice link. These tests leave publicApiUrl
        // unset, so no link is built and it is never called -- but the
        // dependency has to exist for the service to construct.
        { sign: jest.fn().mockReturnValue("tok"), verifyAsync: jest.fn() } as never,
      ),
    };
  }

  describe("issueForPayment", () => {
    it("issues a paid invoice for a cleared payment", async () => {
      const { service, prisma } = build();
      await service.issueForPayment("tx-1");

      const created = prisma.invoice.create.mock.calls[0][0].data;
      expect(created.status).toBe("PAID");
      expect(created.amountUsd).toBe("9.99");
      expect(created.paidAt).toBeInstanceOf(Date);
      // Prepaid: nothing is owed later, so there's no due date to chase.
      expect(created.dueAt).toBeUndefined();
    });

    it("snapshots the plan name instead of referencing it", async () => {
      // Renaming or deleting the plan later must not rewrite what this
      // customer was billed for.
      const { service, prisma } = build();
      await service.issueForPayment("tx-1");

      expect(prisma.invoice.create.mock.calls[0][0].data.planNameSnapshot).toBe("Pro");
    });

    it("does not issue a second invoice when a webhook is redelivered", async () => {
      // Both providers document redelivery. Without this the same money
      // would be invoiced twice.
      const { service, prisma } = build();
      prisma.invoice.findUnique.mockResolvedValue({ id: "inv-existing" });

      const result = await service.issueForPayment("tx-1");

      expect(result).toEqual({ id: "inv-existing" });
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("takes each number from the sequence rather than counting rows", async () => {
      // Counting rows means two concurrent issues compute the same
      // number and collide on the unique index.
      const { service, prisma } = build();
      await service.issueForPayment("tx-1");
      await service.issueForPayment("tx-1");

      const numbers = prisma.invoice.create.mock.calls.map((c) => c[0].data.invoiceNumber);
      expect(new Set(numbers).size).toBe(2);
      expect(numbers[0]).toMatch(/^INV-\d{4}-000001$/);
      expect(numbers[1]).toMatch(/^INV-\d{4}-000002$/);
    });

    it("refuses to invoice a payment that doesn't exist", async () => {
      const { service, prisma } = build();
      prisma.paymentTransaction.findUnique.mockResolvedValue(null);

      await expect(service.issueForPayment("nope")).rejects.toThrow(NotFoundException);
    });
  });

  describe("void", () => {
    it("refuses to void an invoice that was already paid", async () => {
      // That's a refund, which is different accounting. Voiding it would
      // leave money received with nothing recording it.
      const { service, prisma } = build();
      prisma.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "PAID" });

      await expect(service.void("inv-1")).rejects.toThrow(BadRequestException);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("voids an unpaid invoice rather than deleting it", async () => {
      const { service, prisma } = build();
      prisma.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "ISSUED" });

      await service.void("inv-1");

      expect(prisma.invoice.update).toHaveBeenCalledWith({
        where: { id: "inv-1" },
        data: { status: "VOID" },
      });
    });
  });

  describe("summary", () => {
    it("counts only money actually collected", async () => {
      // An issued-but-unpaid invoice is a claim, not revenue.
      const { service, prisma } = build();
      prisma.invoice.findMany.mockResolvedValue([
        { amountUsd: "10.00", planNameSnapshot: "Pro", paymentTransaction: { provider: "STRIPE" } },
        { amountUsd: "5.50", planNameSnapshot: "Pro", paymentTransaction: { provider: "NOWPAYMENTS" } },
        { amountUsd: "4.50", planNameSnapshot: "Lite", paymentTransaction: { provider: "NOWPAYMENTS" } },
      ]);

      const summary = await service.summary(new Date("2026-01-01"));

      expect(prisma.invoice.findMany.mock.calls[0][0].where.status).toBe("PAID");
      expect(summary.totalUsd).toBe("20.00");
      expect(summary.byPlan).toEqual([
        { name: "Pro", amountUsd: "15.50" },
        { name: "Lite", amountUsd: "4.50" },
      ]);
      expect(summary.byProvider).toEqual([
        { provider: "STRIPE", amountUsd: "10.00" },
        { provider: "NOWPAYMENTS", amountUsd: "10.00" },
      ]);
    });
  });

  describe("markOverdue", () => {
    it("only touches unpaid invoices that are actually past due", async () => {
      const { service, prisma } = build();
      await service.markOverdue(new Date("2026-03-01"));

      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where.status).toBe("ISSUED");
      expect(where.dueAt.lt).toEqual(new Date("2026-03-01"));
    });

    it("does nothing when nothing is due, which is the normal case", async () => {
      const { service, prisma } = build();
      const result = await service.markOverdue();

      // A count, not the rows. It used to return every invoice it
      // touched, which a batched sweep cannot do without holding the
      // whole result in memory -- the thing the batching exists to stop.
      expect(result).toBe(0);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });
  });
});
