import { GamingService } from "./gaming.service";
import { listWindow } from "../../common/pagination";

/** What stops `GET /gaming/profiles` from being the whole catalogue.
 *
 * The route it guards used to be `findMany({ orderBy })` and nothing
 * else. At 1,480 rows that is 668,780 B of JSON on a route the panel
 * calls on page load -- a superset of the customer payload, because it
 * also carries `notes`, `processNames`, `destinationCidrs` and the row
 * ids. Compression makes that cheaper on the wire and does not make it
 * bounded: every row is still read, held and serialised first.
 *
 * Each test here fails against the unbounded version, which is the only
 * reason to keep them. */
describe("GET /gaming/profiles bounds", () => {
  type Table = Record<string, jest.Mock>;
  let prisma: { gameProfile: Table; $transaction: jest.Mock };
  let service: GamingService;

  /** A stand-in catalogue big enough that an unbounded query is visibly
   * different from a page of it. */
  const CATALOGUE = Array.from({ length: 1_480 }, (_, i) => ({
    id: `game-${i}`,
    slug: `game-${i}`,
    displayName: `Game ${i}`,
    isActive: true,
  }));

  const DEFAULT_LIMITS = { defaultTake: 100, maxTake: 500 };

  beforeEach(() => {
    prisma = {
      gameProfile: {
        // Answers the way Prisma does: honours take/skip from the args.
        findMany: jest.fn((args: any) =>
          Promise.resolve(CATALOGUE.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? CATALOGUE.length))),
        ),
        count: jest.fn().mockResolvedValue(CATALOGUE.length),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new GamingService(prisma as any);
  });

  function argsOf() {
    return prisma.gameProfile.findMany.mock.calls[0][0];
  }

  it("sends a page, not the catalogue, when the caller asks for nothing", async () => {
    const page = await service.listProfiles({ window: listWindow({}, DEFAULT_LIMITS) });

    expect(argsOf().take).toBe(100);
    expect(page.items).toHaveLength(100);
  });

  /** The header the panel reads. Without a real count the only total
   * available is the length of the page, which would print "100 games"
   * for a catalogue of 1,480 -- a figure that looks right and is not. */
  it("reports the count of every matching row, not the page length", async () => {
    const page = await service.listProfiles({ window: listWindow({}, DEFAULT_LIMITS) });

    expect(page.total).toBe(1_480);
    expect(page.items.length).toBeLessThan(page.total);
  });

  it("pages with skip", async () => {
    const page = await service.listProfiles({
      window: listWindow({ take: "50", skip: "100" }, DEFAULT_LIMITS),
    });

    expect(argsOf()).toMatchObject({ take: 50, skip: 100 });
    expect(page.items[0].slug).toBe("game-100");
  });

  /** The cap is the actual bound. A caller that asks for the table gets
   * a page anyway. */
  it("refuses to widen past the cap however large a take is asked for", async () => {
    await service.listProfiles({ window: listWindow({ take: "100000" }, DEFAULT_LIMITS) });

    expect(argsOf().take).toBe(500);
  });

  describe("the isActive filter", () => {
    it("returns only active profiles by default", async () => {
      await service.listProfiles({ isActive: true, window: listWindow({}, DEFAULT_LIMITS) });

      expect(argsOf().where.isActive).toBe(true);
      expect(prisma.gameProfile.count.mock.calls[0][0].where.isActive).toBe(true);
    });

    it("can still reach deactivated profiles, or a profile could never be turned back on", async () => {
      await service.listProfiles({ isActive: false, window: listWindow({}, DEFAULT_LIMITS) });
      expect(argsOf().where.isActive).toBe(false);

      prisma.gameProfile.findMany.mockClear();
      await service.listProfiles({ window: listWindow({}, DEFAULT_LIMITS) });
      expect(argsOf().where.isActive).toBeUndefined();
    });
  });

  describe("the projection", () => {
    it("names its columns instead of returning the row", async () => {
      await service.listProfiles({ window: listWindow({}, DEFAULT_LIMITS) });

      expect(argsOf().select).toBeDefined();
    });

    /** The three heaviest columns, none of which the table renders.
     * `notes` alone carries a provenance string for all 1,480 rows. The
     * edit form fetches the single row it is editing from
     * `GET /gaming/profiles/:id` instead. */
    it.each(["notes", "processNames", "destinationCidrs"])(
      "leaves %s out of the list, since only the edit form wants it",
      async (column) => {
        await service.listProfiles({ window: listWindow({}, DEFAULT_LIMITS) });

        expect(argsOf().select[column]).toBeUndefined();
      },
    );

    it("still carries what the table renders", async () => {
      await service.listProfiles({ window: listWindow({}, DEFAULT_LIMITS) });

      const select = argsOf().select;
      for (const column of [
        "id",
        "slug",
        "displayName",
        "publisher",
        "hostnames",
        "excludeHostnames",
        "canaryHostname",
        "sortOrder",
        "isActive",
      ]) {
        expect(select[column]).toBe(true);
      }
    });
  });

  describe("search", () => {
    it("filters on the three fields an operator would type into", async () => {
      await service.listProfiles({ search: "blizzard", window: listWindow({}, DEFAULT_LIMITS) });

      const or = argsOf().where.OR;
      expect(or).toHaveLength(3);
      expect(or.map((clause: any) => Object.keys(clause)[0]).sort()).toEqual([
        "displayName",
        "publisher",
        "slug",
      ]);
      for (const clause of or) {
        expect(Object.values(clause)[0]).toMatchObject({ mode: "insensitive" });
      }
    });

    it("adds no clause at all when nothing was searched for", async () => {
      await service.listProfiles({ window: listWindow({}, DEFAULT_LIMITS) });

      expect(argsOf().where.OR).toBeUndefined();
    });
  });
});
