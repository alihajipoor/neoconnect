import { ProtocolUsersService } from "./protocol-users.service";
import { encryptCredentials } from "./credentials-crypto";
import { listWindow } from "../../common/pagination";

/** What stops `GET /protocol-users` from decrypting the whole fleet.
 *
 * `?nodeId` is optional, and without it the route was
 * `findMany({ orderBy })` over every ProtocolUser in the system --
 * then ran each row through `withDecryptedCredentials`. So the
 * unbounded case was not merely a large response: it was one AES-GCM
 * decrypt per customer credential set, with all of the plaintext in a
 * single body. There is one row per subscription per enabled route, so
 * the table is a multiple of the customer count rather than a fraction
 * of it.
 *
 * Each test fails against that version. */
describe("GET /protocol-users bounds", () => {
  type Table = Record<string, jest.Mock>;
  let prisma: { protocolUser: Table; $transaction: jest.Mock };
  let service: ProtocolUsersService;

  const FLEET = Array.from({ length: 1_200 }, (_, i) => ({
    id: `pu-${i}`,
    subscriptionId: `sub-${i}`,
    routeId: "route-1",
    nodeId: i % 3 === 0 ? "node-a" : "node-b",
    protocolConfigId: "cfg-1",
    protocol: "VLESS_REALITY",
    externalUserId: `ext-${i}`,
    credentialsJson: encryptCredentials({ uuid: `uuid-${i}`, flow: "xtls-rprx-vision" }),
    status: "ACTIVE",
    createdAt: new Date(2026, 0, 1),
    updatedAt: new Date(2026, 0, 1),
  }));

  const DEFAULT_LIMITS = { defaultTake: 100, maxTake: 500 };

  beforeEach(() => {
    prisma = {
      protocolUser: {
        findMany: jest.fn((args: any) => {
          const matching = args.where?.nodeId
            ? FLEET.filter((u) => u.nodeId === args.where.nodeId)
            : FLEET;
          return Promise.resolve(
            matching.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? matching.length)),
          );
        }),
        count: jest.fn((args: any) =>
          Promise.resolve(
            args?.where?.nodeId
              ? FLEET.filter((u) => u.nodeId === args.where.nodeId).length
              : FLEET.length,
          ),
        ),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new ProtocolUsersService(prisma as any, {} as any);
  });

  function argsOf() {
    return prisma.protocolUser.findMany.mock.calls[0][0];
  }

  it("sends a page, not the fleet, when the caller asks for nothing", async () => {
    const page = await service.list(undefined, listWindow({}, DEFAULT_LIMITS));

    expect(argsOf().take).toBe(100);
    expect(argsOf().skip).toBe(0);
    expect(page.items).toHaveLength(100);
  });

  /** The bound is on work as much as on bytes: this is the number of
   * credential sets the process decrypts to answer one request. */
  it("decrypts a page's worth of credentials and no more", async () => {
    const page = await service.list(undefined, listWindow({}, DEFAULT_LIMITS));

    expect(page.items).toHaveLength(100);
    expect(page.total).toBe(1_200);
  });

  it("reports the count of every matching row, not the page length", async () => {
    const page = await service.list(undefined, listWindow({}, DEFAULT_LIMITS));

    expect(prisma.protocolUser.count).toHaveBeenCalled();
    expect(page.total).toBe(1_200);
    expect(page.items.length).toBeLessThan(page.total);
  });

  it("pages with skip", async () => {
    const page = await service.list(
      undefined,
      listWindow({ take: "30", skip: "500" }, DEFAULT_LIMITS),
    );

    expect(argsOf()).toMatchObject({ take: 30, skip: 500 });
    expect(page.items[0].id).toBe("pu-500");
  });

  it("refuses to widen past the cap however large a take is asked for", async () => {
    await service.list(undefined, listWindow({ take: "100000" }, DEFAULT_LIMITS));

    expect(argsOf().take).toBe(500);
  });

  describe("the nodeId filter", () => {
    it("counts through the same filter it reads through", async () => {
      const page = await service.list("node-a", listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().where).toEqual({ nodeId: "node-a" });
      expect(prisma.protocolUser.count.mock.calls[0][0].where).toEqual({ nodeId: "node-a" });
      expect(page.total).toBe(400);
    });

    it("adds no clause at all when no node was named", async () => {
      await service.list(undefined, listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().where).toBeUndefined();
    });
  });

  describe("the projection", () => {
    it("names its columns instead of returning the row", async () => {
      await service.list(undefined, listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().select).toBeDefined();
    });

    /** Unusually, `credentialsJson` has to stay: handing an admin the
     * usable credentials is the reason this endpoint exists. What the
     * named projection buys is that the next column added to the model
     * -- as likely to be a secret as not -- does not join the response
     * without somebody deciding it should. */
    it("keeps every column the response is built from", async () => {
      await service.list(undefined, listWindow({}, DEFAULT_LIMITS));

      const select = argsOf().select;
      for (const column of [
        "id",
        "subscriptionId",
        "routeId",
        "nodeId",
        "protocolConfigId",
        "protocol",
        "externalUserId",
        "credentialsJson",
        "status",
        "createdAt",
        "updatedAt",
      ]) {
        expect(select[column]).toBe(true);
      }
    });
  });

  /** The window bounds how many rows come back, not what one looks
   * like. An admin retrieving credentials to hand to a customer must get
   * the same thing they always did. */
  describe("the decryption, unchanged", () => {
    it("replaces the encrypted column with the credentials it held", async () => {
      const page = await service.list(undefined, listWindow({ take: "1" }, DEFAULT_LIMITS));

      expect(page.items[0].credentials).toEqual({ uuid: "uuid-0", flow: "xtls-rprx-vision" });
    });

    it("never leaves the ciphertext on the row it hands back", async () => {
      const page = await service.list(undefined, listWindow({ take: "5" }, DEFAULT_LIMITS));

      for (const user of page.items) {
        expect(user).not.toHaveProperty("credentialsJson");
      }
    });
  });
});
