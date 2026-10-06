import { ProtocolUsersService } from "./protocol-users.service";
import { deviceSlotsStub } from "../../../test/device-slots-stub";

/** Provisioning every route a plan allows, so the client can fail over
 * between protocols without reaching the control plane -- which, on a
 * censored network, is a plausible thing to lose first. */
describe("ProtocolUsersService.provisionAll", () => {
  const ROUTES = [{ id: "route-reality" }, { id: "route-tls" }, { id: "route-wg" }];

  function build(existingRouteIds: string[] = [], status = "ACTIVE") {
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sub-1",
          status,
          plan: { protocolsAllowed: ["XRAY_VLESS_REALITY", "XRAY_VLESS_TLS", "WIREGUARD"], allowedRoutes: [] },
        }),
      },
      route: { findMany: jest.fn().mockResolvedValue(ROUTES) },
      protocolUser: {
        findMany: jest.fn().mockResolvedValue(existingRouteIds.map((routeId) => ({ routeId }))),
      },
    };
    const service = new ProtocolUsersService(prisma as never, {} as never, deviceSlotsStub() as never);
    // create() is exercised by its own tests; here what matters is which
    // routes it is asked for, and how many times.
    const create = jest
      .spyOn(service, "create")
      .mockImplementation(({ routeId }) => Promise.resolve({ routeId } as never));
    return { service, prisma, create };
  }

  it("provisions one credential per allowed route", async () => {
    const { service, create } = build();

    const { created } = await service.provisionAll("sub-1");

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

    const { created } = await service.provisionAll("sub-1");

    expect(created).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].routeId).toBe("route-tls");
  });

  it("does nothing at all when every route is already provisioned", async () => {
    const { service, create } = build(["route-reality", "route-tls", "route-wg"]);

    await expect(service.provisionAll("sub-1")).resolves.toEqual({ created: [], revoked: [], failed: [] });
    expect(create).not.toHaveBeenCalled();
  });

  /** Runs on a confirmed payment, a renewal, a trial and a voucher. A
   * WireGuard pool with no address left used to throw out of here and
   * take every later route -- and the caller's invoice -- with it. */
  it("provisions every other route when one cannot be, and says which", async () => {
    const { service, create } = build();
    create.mockImplementation(({ routeId }) =>
      routeId === "route-reality"
        ? Promise.reject(new Error("No free addresses left in WireGuard subnet 10.66.0.0/24"))
        : Promise.resolve({ routeId } as never),
    );

    const result = await service.provisionAll("sub-1");

    expect(result.created.map((u) => (u as { routeId: string }).routeId).sort()).toEqual(["route-tls", "route-wg"]);
    expect(result.failed).toEqual([
      { routeId: "route-reality", reason: "No free addresses left in WireGuard subnet 10.66.0.0/24" },
    ]);
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

  /** A plan route edit, a plan change and the boot backfill all reach
   * subscriptions that are not ACTIVE -- every abandoned checkout ever
   * made on the plan, among others. A missing route there used to become
   * an ENABLED credential nobody paid for, which expiry and quota never
   * switched off because they only act on ACTIVE subscriptions. */
  it.each(["PENDING", "CANCELLED", "EXPIRED", "SUSPENDED"])(
    "creates nothing for a %s subscription",
    async (status) => {
      const { service, create } = build([], status);

      await expect(service.provisionAll("sub-1")).resolves.toEqual({ created: [], revoked: [], failed: [] });
      expect(create).not.toHaveBeenCalled();
    },
  );

  /** Taking away is still right whatever the status: a route the plan no
   * longer allows must not survive on a suspended subscription until its
   * renewal. */
  it("still revokes what the plan no longer allows from a subscription that is not ACTIVE", async () => {
    const { service, prisma, create } = build([], "SUSPENDED");
    prisma.protocolUser.findMany.mockResolvedValue([{ id: "pu-old", routeId: "route-gone", sessionId: null }]);
    const remove = jest.spyOn(service, "remove").mockResolvedValue(undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);

    const result = await service.provisionAll("sub-1");

    expect(remove).toHaveBeenCalledWith("pu-old");
    expect(result).toEqual({ created: [], revoked: ["pu-old"], failed: [] });
    expect(create).not.toHaveBeenCalled();
  });
});
