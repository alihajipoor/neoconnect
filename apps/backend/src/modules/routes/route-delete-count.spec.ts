/* eslint-disable @typescript-eslint/require-await -- Prisma stand-ins
   match the client's async signatures. */
import { RoutesService } from "./routes.service";

/** Deleting a route revokes every credential on it rather than refusing
 * (M23). The panel's confirmation said customers would block the delete;
 * it now says how many credentials go, which it reads from the list. */
describe("deleting a route with customers on it", () => {
  it("lists each route with how many credentials it carries", async () => {
    const prisma = {
      route: {
        findMany: jest.fn(async () => [
          { id: "route-1", name: "Iran relay", _count: { protocolUsers: 37 } },
          { id: "route-2", name: "Spare", _count: { protocolUsers: 0 } },
        ]),
      },
    };
    const service = new RoutesService(prisma as never, {} as never, {} as never, {} as never);
    expect(await service.list()).toEqual([
      { id: "route-1", name: "Iran relay", protocolUserCount: 37 },
      { id: "route-2", name: "Spare", protocolUserCount: 0 },
    ]);
    expect(prisma.route.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: { _count: { select: { protocolUsers: true } } } }),
    );
  });

  it("revokes them all and deletes the route, which is what the dialog has to say", async () => {
    const users = [{ id: "pu-1" }, { id: "pu-2" }];
    const prisma = {
      route: {
        findUnique: jest.fn(async () => ({ id: "route-1", exitProtocolConfigId: null, entryProtocolConfigId: "cfg" })),
        delete: jest.fn(async () => ({})),
      },
      protocolUser: { findMany: jest.fn(async () => users) },
    };
    const removed: string[] = [];
    const protocolUsers = {
      remove: jest.fn(async (id: string) => {
        removed.push(id);
      }),
    };
    const service = new RoutesService(prisma as never, {} as never, protocolUsers as never, {} as never);
    await service.remove("route-1");
    expect(removed).toEqual(["pu-1", "pu-2"]);
    expect(prisma.route.delete).toHaveBeenCalledWith({ where: { id: "route-1" } });
  });
});
