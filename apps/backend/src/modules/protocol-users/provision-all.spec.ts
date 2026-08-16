import { ProtocolUsersService } from "./protocol-users.service";

/** Provisioning every route a plan allows, so the client can fail over
 * between protocols without reaching the control plane -- which, on a
 * censored network, is a plausible thing to lose first. */
describe("ProtocolUsersService.provisionAll", () => {
  const ROUTES = [{ id: "route-reality" }, { id: "route-tls" }, { id: "route-wg" }];

  function build(existingRouteIds: string[] = []) {
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sub-1",
          plan: { protocolsAllowed: ["XRAY_VLESS_REALITY", "XRAY_VLESS_TLS", "WIREGUARD"], allowedRoutes: [] },
        }),
      },
      route: { findMany: jest.fn().mockResolvedValue(ROUTES) },
      protocolUser: {
        findMany: jest.fn().mockResolvedValue(existingRouteIds.map((routeId) => ({ routeId }))),
      },
    };
    const service = new ProtocolUsersService(prisma as never, {} as never);
    // create() is exercised by its own tests; here what matters is which
    // routes it is asked for, and how many times.
    const create = jest
      .spyOn(service, "create")
      .mockImplementation(({ routeId }) => Promise.resolve({ routeId } as never));
    return { service, prisma, create };
  }

  it("provisions one credential per allowed route", async () => {
    const { service, create } = build();

    const created = await service.provisionAll("sub-1");

    expect(created).toHaveLength(3);
    expect(create.mock.calls.map((c) => c[0].routeId).sort()).toEqual([
      "route-reality",
      "route-tls",
      "route-wg",
    ]);
  });

  /** Runs on first payment, every renewal, plan changes, new routes and
   * the backfill -- so re-running it must never disturb a connected
   * customer by tearing down what they are using. */
  it("skips routes the subscription already has instead of recreating them", async () => {
    const { service, create } = build(["route-reality", "route-wg"]);

    const created = await service.provisionAll("sub-1");

    expect(created).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].routeId).toBe("route-tls");
  });

  it("does nothing at all when every route is already provisioned", async () => {
    const { service, create } = build(["route-reality", "route-tls", "route-wg"]);

    await expect(service.provisionAll("sub-1")).resolves.toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  /** Only routes whose protocol the plan sells, and only enabled ones --
   * asserted on the query itself because the filtering has to happen in
   * the database, not after. */
  it("asks only for enabled routes whose protocol the plan allows", async () => {
    const { service, prisma } = build();

    await service.provisionAll("sub-1");

    const { where } = prisma.route.findMany.mock.calls[0][0] as {
      where: { isEnabled: boolean; entryProtocolConfig: { protocol: { in: string[] }; isEnabled: boolean } };
    };
    expect(where.isEnabled).toBe(true);
    expect(where.entryProtocolConfig.isEnabled).toBe(true);
    expect(where.entryProtocolConfig.protocol.in).toEqual([
      "XRAY_VLESS_REALITY",
      "XRAY_VLESS_TLS",
      "WIREGUARD",
    ]);
  });

  /** WireGuard picks each peer's address by reading the ones already
   * taken, so two routes on one node provisioned concurrently can choose
   * the same address. Sequential creation is load-bearing, not style. */
  it("creates sequentially so WireGuard address allocation cannot collide", async () => {
    const { service } = build();
    let inFlight = 0;
    let overlapped = false;

    jest.spyOn(service, "create").mockImplementation(async ({ routeId }) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { routeId } as never;
    });

    await service.provisionAll("sub-1");

    expect(overlapped).toBe(false);
  });
});
