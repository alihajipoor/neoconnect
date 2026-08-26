import { CustomersService } from "../modules/customers/customers.service";
import { SubscriptionsService } from "../modules/subscriptions/subscriptions.service";
import { InvoicesService } from "../modules/invoices/invoices.service";
import { listWindow } from "./pagination";

/** The three admin lists that grow with the customer base.
 *
 * Each of these was `findMany` with an `orderBy` and no `take`. They are
 * grouped in one file because the failure is one failure: a list route
 * whose cost is "however many rows exist", on pages an operator opens
 * every day.
 *
 * Every assertion here is against the arguments actually handed to
 * Prisma, so each one fails if the `take` is removed again. */
describe("admin list windows", () => {
  const LIMITS = { defaultTake: 100, maxTake: 500 };

  /** A prisma stub whose `findMany` honours take/skip the way the real
   * client does, so a missing bound shows up as a longer array and not
   * only as a missing argument. */
  function tableOf(rows: unknown[]) {
    return {
      findMany: jest.fn((args: any) =>
        Promise.resolve(rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length))),
      ),
      count: jest.fn().mockResolvedValue(rows.length),
    };
  }

  const $transaction = () => jest.fn((ops: Promise<unknown>[]) => Promise.all(ops));

  describe("GET /customers", () => {
    const ROWS = Array.from({ length: 4_000 }, (_, i) => ({ id: `customer-${i}` }));
    let customer: ReturnType<typeof tableOf>;
    let service: CustomersService;

    beforeEach(() => {
      customer = tableOf(ROWS);
      service = new CustomersService({ customer, $transaction: $transaction() } as any, {} as any);
    });

    it("returns a page rather than every customer", async () => {
      const page = await service.list(listWindow({}, LIMITS));

      expect(customer.findMany.mock.calls[0][0].take).toBe(100);
      expect(page.items).toHaveLength(100);
    });

    /** The overview dashboard prints this as its headline "Customers"
     * figure. It used to come from the length of an unpaginated
     * response, so a page size would have quietly become the customer
     * count. */
    it("reports the real customer count, not the page length", async () => {
      const page = await service.list(listWindow({}, LIMITS));

      expect(customer.count).toHaveBeenCalled();
      expect(page.total).toBe(4_000);
    });

    it("pages, and refuses to be widened past the cap", async () => {
      const page = await service.list(listWindow({ take: "10", skip: "3" }, LIMITS));
      expect(page.items[0]).toEqual({ id: "customer-3" });

      await service.list(listWindow({ take: "999999" }, LIMITS));
      expect(customer.findMany.mock.calls[1][0].take).toBe(500);
    });

    /** Unchanged by this work and worth a guard anyway: the list has
     * never carried `passwordHash`, `tokenVersion` or the one-time
     * codes, and a `take` is no reason for that to slip. */
    it("still projects named columns and no secrets", async () => {
      await service.list(listWindow({}, LIMITS));

      const select = customer.findMany.mock.calls[0][0].select;
      expect(select.email).toBe(true);
      for (const secret of ["passwordHash", "tokenVersion", "emailVerificationCode", "passwordResetCode"]) {
        expect(select[secret]).toBeUndefined();
      }
    });
  });

  describe("GET /subscriptions", () => {
    const ROWS = Array.from({ length: 900 }, (_, i) => ({ id: `sub-${i}` }));
    let subscription: ReturnType<typeof tableOf>;
    let service: SubscriptionsService;

    beforeEach(() => {
      subscription = tableOf(ROWS);
      service = new SubscriptionsService({ subscription, $transaction: $transaction() } as any, {} as any);
    });

    it("returns a page rather than every subscription ever created", async () => {
      const page = await service.list(listWindow({}, LIMITS));

      expect(subscription.findMany.mock.calls[0][0].take).toBe(100);
      expect(page.total).toBe(900);
    });

    /** The per-customer sibling is deliberately left unwindowed: it is
     * already bounded by the one customer it names, and it is what the
     * customer app calls. */
    it("leaves listByCustomer alone", async () => {
      subscription.findMany.mockClear();
      await service.listByCustomer("customer-1");

      const args = subscription.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ customerId: "customer-1" });
      expect(args.take).toBeUndefined();
    });
  });

  describe("GET /invoices", () => {
    const ROWS = Array.from({ length: 2_500 }, (_, i) => ({ id: `inv-${i}` }));
    let invoice: ReturnType<typeof tableOf>;
    let service: InvoicesService;

    beforeEach(() => {
      invoice = tableOf(ROWS);
      service = new InvoicesService(
        { invoice, $transaction: $transaction() } as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it("returns a page rather than every invoice ever issued", async () => {
      const page = await service.listPage({}, listWindow({}, LIMITS));

      expect(invoice.findMany.mock.calls[0][0].take).toBe(100);
      expect(page.items).toHaveLength(100);
      expect(page.total).toBe(2_500);
    });

    /** The count has to see the same filter as the page, or the panel
     * reports a filtered list against an unfiltered total. */
    it("counts against the same where clause it lists against", async () => {
      await service.listPage({ customerId: "customer-1", status: "PAID" as any }, listWindow({}, LIMITS));

      expect(invoice.count.mock.calls[0][0].where).toEqual(invoice.findMany.mock.calls[0][0].where);
      expect(invoice.count.mock.calls[0][0].where).toMatchObject({
        customerId: "customer-1",
        status: "PAID",
      });
    });

    /** `lineItemsJson` is the largest column on the model and the table
     * shows one total per row, not a breakdown. */
    it("leaves lineItemsJson out of the list projection", async () => {
      await service.listPage({}, listWindow({}, LIMITS));

      const select = invoice.findMany.mock.calls[0][0].select;
      expect(select).toBeDefined();
      expect(select.lineItemsJson).toBeUndefined();
      expect(select.amountUsd).toBe(true);
    });

    /** `GET /customer/invoices` goes through `list`, not `listPage`, and
     * must keep returning what it returned before -- it is the one path
     * here a shipped client could be reading. */
    it("leaves the customer-facing list's shape untouched", async () => {
      invoice.findMany.mockClear();
      await service.list({ customerId: "customer-1" });

      const args = invoice.findMany.mock.calls[0][0];
      expect(args.take).toBeUndefined();
      expect(args.select).toBeUndefined();
      expect(args.include).toMatchObject({ customer: { select: { email: true } } });
    });
  });
});
