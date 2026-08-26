import { ResellersService } from "./resellers.service";
import { listWindow } from "../../common/pagination";

/** What stops `GET /reseller/vouchers` from being one reseller's whole
 * history.
 *
 * The WHERE clause on `issuedByAdminId` is an authorisation boundary,
 * not a bound: it is what stops a reseller seeing somebody else's codes,
 * and it says nothing about how many of their own there are. A reseller
 * a year into selling has every code they ever minted still on the
 * table, because revoking is only possible before redemption -- after
 * that the row stays for the record.
 *
 * The projection is the second half. `myVouchers` already hand-picked
 * nine fields when mapping, so everything else on the row was read from
 * Postgres and discarded.
 *
 * Each test fails against the unbounded version. */
describe("GET /reseller/vouchers bounds", () => {
  type Table = Record<string, jest.Mock>;
  let prisma: { voucher: Table; $transaction: jest.Mock };
  let service: ResellersService;

  const ADMIN = "admin-1";

  const MINE = Array.from({ length: 730 }, (_, i) => ({
    id: `v-${i}`,
    code: `CODE${i}`,
    recipientEmail: `buyer${i}@example.com`,
    createdAt: new Date(2026, 0, 1),
    expiresAt: null,
    isActive: true,
    redeemedCount: i % 2,
    plan: { id: "plan-1", name: "Pro" },
    redemptions: i % 2 ? [{ redeemedAt: new Date(2026, 0, 2) }] : [],
  }));

  const DEFAULT_LIMITS = { defaultTake: 100, maxTake: 500 };

  beforeEach(() => {
    prisma = {
      voucher: {
        findMany: jest.fn((args: any) =>
          Promise.resolve(MINE.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? MINE.length))),
        ),
        count: jest.fn().mockResolvedValue(MINE.length),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new ResellersService(prisma as any, {} as any, {} as any, {} as any);
  });

  function argsOf() {
    return prisma.voucher.findMany.mock.calls[0][0];
  }

  it("sends a page, not the history, when the caller asks for nothing", async () => {
    const page = await service.myVouchers(ADMIN, listWindow({}, DEFAULT_LIMITS));

    expect(argsOf().take).toBe(100);
    expect(argsOf().skip).toBe(0);
    expect(page.items).toHaveLength(100);
  });

  it("reports the count of every code this reseller issued, not the page length", async () => {
    const page = await service.myVouchers(ADMIN, listWindow({}, DEFAULT_LIMITS));

    expect(prisma.voucher.count).toHaveBeenCalled();
    expect(page.total).toBe(730);
    expect(page.items.length).toBeLessThan(page.total);
  });

  /** The scope has to be on the count as well as the page, or a reseller
   * would be told how many codes exist in the whole system. */
  it("counts through the same ownership scope it reads through", async () => {
    await service.myVouchers(ADMIN, listWindow({}, DEFAULT_LIMITS));

    expect(argsOf().where).toEqual({ issuedByAdminId: ADMIN });
    expect(prisma.voucher.count.mock.calls[0][0].where).toEqual({ issuedByAdminId: ADMIN });
  });

  it("pages with skip", async () => {
    const page = await service.myVouchers(
      ADMIN,
      listWindow({ take: "40", skip: "120" }, DEFAULT_LIMITS),
    );

    expect(argsOf()).toMatchObject({ take: 40, skip: 120 });
    expect(page.items[0].code).toBe("CODE120");
  });

  it("refuses to widen past the cap however large a take is asked for", async () => {
    await service.myVouchers(ADMIN, listWindow({ take: "50000" }, DEFAULT_LIMITS));

    expect(argsOf().take).toBe(500);
  });

  describe("the projection", () => {
    it("names its columns instead of returning the row", async () => {
      await service.myVouchers(ADMIN, listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().select).toBeDefined();
      expect(argsOf().include).toBeUndefined();
    });

    /** Exactly the fields the mapping consumes, and no others. Reading a
     * column in order to drop it is the whole cost with none of the
     * use. */
    it("asks for the nine fields the mapping uses and nothing else", async () => {
      await service.myVouchers(ADMIN, listWindow({}, DEFAULT_LIMITS));

      const select = argsOf().select;
      expect(Object.keys(select).sort()).toEqual([
        "code",
        "createdAt",
        "expiresAt",
        "id",
        "isActive",
        "plan",
        "recipientEmail",
        "redeemedCount",
        "redemptions",
      ]);
    });

    /** `issuedByAdminId` is already pinned by the WHERE clause, and
     * `note` and `maxRedemptions` are fixed by `generate` -- none of the
     * three tells the reseller anything they did not already know. */
    it.each(["issuedByAdminId", "note", "maxRedemptions", "planId", "updatedAt"])(
      "leaves %s out, since the mapping never reads it",
      async (column) => {
        await service.myVouchers(ADMIN, listWindow({}, DEFAULT_LIMITS));

        expect(argsOf().select[column]).toBeUndefined();
      },
    );

    it("still fetches only the one redemption the redeemedAt column needs", async () => {
      await service.myVouchers(ADMIN, listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().select.redemptions).toMatchObject({ take: 1 });
      expect(argsOf().select.redemptions.select).toEqual({ redeemedAt: true });
    });
  });

  /** The rows themselves are unchanged: the window bounds how many come
   * back, not what one looks like. */
  it("still maps a row the way the panel reads it", async () => {
    const page = await service.myVouchers(ADMIN, listWindow({ take: "2" }, DEFAULT_LIMITS));

    expect(page.items[0]).toMatchObject({
      id: "v-0",
      code: "CODE0",
      plan: { id: "plan-1", name: "Pro" },
      recipientEmail: "buyer0@example.com",
      redeemedAt: null,
      canRevoke: true,
    });
    expect(page.items[1]).toMatchObject({ canRevoke: false });
    expect(page.items[1].redeemedAt).toEqual(new Date(2026, 0, 2));
  });
});
