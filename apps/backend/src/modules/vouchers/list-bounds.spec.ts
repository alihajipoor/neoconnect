import { VouchersService } from "./vouchers.service";
import { listWindow } from "../../common/pagination";

/** What stops `GET /vouchers` from being the whole voucher table.
 *
 * A code is switched off rather than deleted -- that is deliberate, so
 * the record of who redeemed what survives -- which makes this a table
 * that only ever grows, and it was read in full on every load of the
 * vouchers screen.
 *
 * The projection matters here for a second reason. `recipientEmail` is a
 * buyer's address, written by the reseller programme, and the
 * unfiltered `findMany` put every one of them on a screen that has never
 * had a column for it.
 *
 * Each test fails against the unbounded version. */
describe("GET /vouchers bounds", () => {
  type Table = Record<string, jest.Mock>;
  let prisma: { voucher: Table; $transaction: jest.Mock };
  let service: VouchersService;

  const VOUCHERS = Array.from({ length: 4_200 }, (_, i) => ({
    id: `v-${i}`,
    code: `CODE${i}`,
    isActive: true,
  }));

  const DEFAULT_LIMITS = { defaultTake: 100, maxTake: 500 };

  beforeEach(() => {
    prisma = {
      voucher: {
        findMany: jest.fn((args: any) =>
          Promise.resolve(
            VOUCHERS.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? VOUCHERS.length)),
          ),
        ),
        count: jest.fn().mockResolvedValue(VOUCHERS.length),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new VouchersService(prisma as any, {} as any, {} as any);
  });

  function argsOf() {
    return prisma.voucher.findMany.mock.calls[0][0];
  }

  it("sends a page, not the table, when the caller asks for nothing", async () => {
    const page = await service.list(listWindow({}, DEFAULT_LIMITS));

    expect(argsOf().take).toBe(100);
    expect(argsOf().skip).toBe(0);
    expect(page.items).toHaveLength(100);
  });

  it("reports the count of every voucher, not the page length", async () => {
    const page = await service.list(listWindow({}, DEFAULT_LIMITS));

    expect(prisma.voucher.count).toHaveBeenCalled();
    expect(page.total).toBe(4_200);
    expect(page.items.length).toBeLessThan(page.total);
  });

  it("pages with skip", async () => {
    const page = await service.list(listWindow({ take: "25", skip: "300" }, DEFAULT_LIMITS));

    expect(argsOf()).toMatchObject({ take: 25, skip: 300 });
    expect(page.items[0].code).toBe("CODE300");
  });

  it("refuses to widen past the cap however large a take is asked for", async () => {
    await service.list(listWindow({ take: "999999" }, DEFAULT_LIMITS));

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
      expect(argsOf().include).toBeUndefined();
    });

    /** A buyer's address on an operator-wide list of every code in the
     * system, displayed by nothing. The reseller's own history is where
     * it belongs, scoped to the codes that reseller issued. */
    it("leaves the recipient's email address out", async () => {
      await service.list(listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().select.recipientEmail).toBeUndefined();
    });

    it("still carries every column the voucher table renders", async () => {
      await service.list(listWindow({}, DEFAULT_LIMITS));

      const select = argsOf().select;
      for (const column of [
        "id",
        "code",
        "planId",
        "maxRedemptions",
        "redeemedCount",
        "expiresAt",
        "isActive",
        "note",
      ]) {
        expect(select[column]).toBe(true);
      }
    });

    /** Under a `select` these are nested selects rather than includes.
     * The JSON is the same shape the table already reads, which is the
     * point -- the plan's name is a cell and the redemption count backs
     * the delete warning. */
    it("keeps the plan and the redemption count the table depends on", async () => {
      await service.list(listWindow({}, DEFAULT_LIMITS));

      const select = argsOf().select;
      expect(select.plan.select).toMatchObject({ id: true, name: true });
      expect(select._count.select.redemptions).toBe(true);
    });
  });
});
