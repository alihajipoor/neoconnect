import { BillingService } from "./billing.service";
import { listWindow } from "../../common/pagination";

/** What stops `GET /billing/payments` from being every payment ever taken.
 *
 * The route was `findMany({ orderBy })` with no where, no take and no
 * select, over a table that gains a row per payment *attempt* -- the
 * abandoned and failed ones included -- and is never pruned. It also
 * carried `rawWebhookPayload`, the provider's callback body stored
 * verbatim, which is the largest column on the row and is rendered by
 * nothing: there is no panel file that reads a payment transaction at
 * all, so every byte of every Stripe event object was being serialised
 * for a caller that had no field to put it in.
 *
 * Each test here fails against that version. */
describe("GET /billing/payments bounds", () => {
  type Table = Record<string, jest.Mock>;
  let prisma: { paymentTransaction: Table; $transaction: jest.Mock };
  let service: BillingService;

  /** Bigger than the default page, so a bounded query and an unbounded
   * one cannot produce the same answer. */
  const PAYMENTS = Array.from({ length: 640 }, (_, i) => ({
    id: `pay-${i}`,
    providerRef: `ref-${i}`,
    status: "SUCCEEDED",
  }));

  const DEFAULT_LIMITS = { defaultTake: 100, maxTake: 500 };

  beforeEach(() => {
    prisma = {
      paymentTransaction: {
        findMany: jest.fn((args: any) =>
          Promise.resolve(
            PAYMENTS.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? PAYMENTS.length)),
          ),
        ),
        count: jest.fn().mockResolvedValue(PAYMENTS.length),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new BillingService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  function argsOf() {
    return prisma.paymentTransaction.findMany.mock.calls[0][0];
  }

  it("sends a page, not the ledger, when the caller asks for nothing", async () => {
    const page = await service.list(listWindow({}, DEFAULT_LIMITS));

    expect(argsOf().take).toBe(100);
    expect(argsOf().skip).toBe(0);
    expect(page.items).toHaveLength(100);
  });

  /** The header the panel reads. A total inferred from the page would
   * print "100 payments" for a ledger of 640 -- a figure that looks
   * right and is not, which is the one thing paging must not
   * reintroduce. */
  it("reports the count of every row, not the page length", async () => {
    const page = await service.list(listWindow({}, DEFAULT_LIMITS));

    expect(prisma.paymentTransaction.count).toHaveBeenCalled();
    expect(page.total).toBe(640);
    expect(page.items.length).toBeLessThan(page.total);
  });

  it("pages with skip", async () => {
    const page = await service.list(listWindow({ take: "50", skip: "200" }, DEFAULT_LIMITS));

    expect(argsOf()).toMatchObject({ take: 50, skip: 200 });
    expect(page.items[0].id).toBe("pay-200");
  });

  it("refuses to widen past the cap however large a take is asked for", async () => {
    await service.list(listWindow({ take: "100000" }, DEFAULT_LIMITS));

    expect(argsOf().take).toBe(500);
  });

  it("takes the page and the count in one round trip", async () => {
    await service.list(listWindow({}, DEFAULT_LIMITS));

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  describe("the projection", () => {
    it("names its columns instead of returning the row", async () => {
      await service.list(listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().select).toBeDefined();
    });

    /** The provider's webhook body, verbatim. Nothing renders it, and
     * `reconcile` reads the single row it needs through `get()`. */
    it("leaves rawWebhookPayload out, since it is an unfiltered third-party payload", async () => {
      await service.list(listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().select.rawWebhookPayload).toBeUndefined();
    });

    it("still carries what identifies and reconciles a payment", async () => {
      await service.list(listWindow({}, DEFAULT_LIMITS));

      const select = argsOf().select;
      for (const column of [
        "id",
        "customerId",
        "subscriptionId",
        "provider",
        "providerRef",
        "amountUsd",
        "currency",
        "status",
        "createdAt",
        "updatedAt",
      ]) {
        expect(select[column]).toBe(true);
      }
    });
  });
});
