import { BadRequestException } from "@nestjs/common";
import { ProtocolUsersService } from "./protocol-users.service";

/**
 * The per-plan route selection.
 *
 * This is now the ONLY rule. There is no relay/direct split beside it
 * and no implicit "everything" behind it: a plan is exactly the routes
 * an operator ticked, relay or direct alike.
 *
 * Empty therefore means no service. That was safe to introduce only
 * because a migration first wrote every existing plan's effective route
 * set down explicitly -- flipping the meaning against an empty join
 * table would have cut off every customer at once.
 */
describe("the plan's route selection", () => {
  function serviceFor(selected: string[], routeId = "route-1") {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sub-1",
          plan: {
            name: "Pro",
            relayOnly: false,
            protocolsAllowed: ["XRAY_VLESS_REALITY"],
            allowedRoutes: selected.map((id) => ({ id })),
          },
        }),
      },
      route: {
        findMany,
        findUnique: jest.fn().mockResolvedValue({
          id: routeId,
          name: "finland1 direct",
          isEnabled: true,
          exitProtocolConfigId: null,
          entryProtocolConfig: { id: "cfg-1", nodeId: "n1", protocol: "XRAY_VLESS_REALITY", node: {} },
        }),
      },
      protocolUser: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    };
    const agentGateway = { enqueueCommand: jest.fn().mockResolvedValue(undefined) };
    return { service: new ProtocolUsersService(prisma as never, agentGateway as never), prisma, findMany };
  }

  it("an EMPTY selection serves nothing", async () => {
    // The owner's decision: explicit selection is required, so a plan
    // nobody has finished configuring provisions no credentials rather
    // than quietly handing out every route on the fleet.
    const { service, findMany } = serviceFor([]);
    await service.provisionAll("sub-1").catch(() => undefined);

    expect(findMany.mock.calls[0][0].where.id).toEqual({ in: [] });
  });

  it("a non-empty selection narrows the query to those routes", async () => {
    const { service, findMany } = serviceFor(["route-a", "route-b"]);
    await service.provisionAll("sub-1").catch(() => undefined);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["route-a", "route-b"] } }),
      }),
    );
  });

  it("refuses to create on a route the plan has not selected", async () => {
    // Same argument as the relayOnly chokepoint: a selection that only
    // shaped what provisionAll offers would be a setting the admin can
    // see and nothing can rely on.
    const { service, prisma } = serviceFor(["route-other"], "route-1");
    await expect(service.create({ subscriptionId: "sub-1", routeId: "route-1" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.protocolUser.create).not.toHaveBeenCalled();
  });

  it("allows a route that IS selected", async () => {
    const { service, prisma } = serviceFor(["route-1"], "route-1");
    await service.create({ subscriptionId: "sub-1", routeId: "route-1" }).catch(() => undefined);
    expect(prisma.protocolUser.create).toHaveBeenCalled();
  });

  it("allows a RELAY route on any plan that selected it", async () => {
    // The relay/direct split is gone. A relay route is now just a route
    // somebody chose, so a plan that ticked one is served by it -- which
    // is what the owner asked for after the split proved too rigid to
    // express plans like "Pro, plus one Iran entry".
    const { service, prisma } = serviceFor(["route-1"], "route-1");
    prisma.route.findUnique.mockResolvedValue({
      id: "route-1",
      name: "ir1 relay -> finland1",
      isEnabled: true,
      exitProtocolConfigId: "exit-cfg-1",
      entryProtocolConfig: { id: "cfg-1", nodeId: "n1", protocol: "XRAY_VLESS_REALITY", node: {} },
    });

    await service.create({ subscriptionId: "sub-1", routeId: "route-1" }).catch(() => undefined);
    expect(prisma.protocolUser.create).toHaveBeenCalled();
  });
});

/**
 * Reconciliation: provisionAll removes what the plan no longer allows.
 *
 * It only ever added, which made relayOnly true of future provisioning
 * and false of the customers who already existed -- the two live Ultimate
 * subscribers kept 16 direct-route credentials issued before the flag
 * was introduced, so the plan sold as the Iran relay path was being
 * served, for them, by direct routes.
 *
 * The disabled-route case below is the one that makes this safe to run
 * on a live fleet, and is the reason revocation keys off plan policy
 * rather than off what is currently reachable.
 */
describe("provisionAll: revoking what the plan no longer allows", () => {
  function serviceFor(opts: {
    selected: string[];
    routes: { id: string; isEnabled?: boolean; entryEnabled?: boolean }[];
    existing: { id: string; routeId: string }[];
  }) {
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sub-1",
          plan: {
            name: "Pro",
            protocolsAllowed: ["WIREGUARD"],
            allowedRoutes: opts.selected.map((id) => ({ id })),
          },
        }),
      },
      route: {
        // Honours the WHERE rather than returning one canned list, because
        // provisionAll now asks two different questions of this table and
        // the difference between them is the whole point. A mock that
        // answered both identically would let the disabled-route test
        // below pass without the distinction existing at all.
        findMany: jest.fn(({ where }: { where: { isEnabled?: boolean } }) =>
          Promise.resolve(
            opts.routes
              .filter((r) => (where.isEnabled === true ? (r.isEnabled ?? true) && (r.entryEnabled ?? true) : true))
              .map((r) => ({ id: r.id })),
          ),
        ),
      },
      protocolUser: { findMany: jest.fn().mockResolvedValue(opts.existing) },
    };
    const service = new ProtocolUsersService(prisma as never, {} as never);
    jest.spyOn(service, "create").mockImplementation(({ routeId }) => Promise.resolve({ routeId } as never));
    const remove = jest.spyOn(service, "remove").mockResolvedValue(undefined as never);
    return { service, remove };
  }

  it("revokes a credential on a route the plan does not allow", async () => {
    // The Ultimate case exactly: the relay route is allowed and held,
    // the direct one is a leftover and must go.
    const { service, remove } = serviceFor({
      selected: ["relay-1"],
      routes: [{ id: "relay-1" }],
      existing: [
        { id: "pu-relay", routeId: "relay-1" },
        { id: "pu-direct", routeId: "direct-1" },
      ],
    });

    await service.provisionAll("sub-1");

    expect(remove).toHaveBeenCalledWith("pu-direct");
    expect(remove).not.toHaveBeenCalledWith("pu-relay");
  });

  it("does NOT revoke a credential whose route is merely disabled", async () => {
    // The case that makes this safe to run against production. A route
    // disabled for maintenance is still allowed by the plan, so the
    // credential stays: otherwise a ten-minute maintenance window would
    // delete every customer's credential on that route and rebuild it on
    // re-enable, dropping anyone connected through it for a reason that
    // had nothing to do with their plan.
    const { service, remove } = serviceFor({
      selected: ["direct-1"],
      routes: [{ id: "direct-1", isEnabled: false }],
      existing: [{ id: "pu-direct", routeId: "direct-1" }],
    });

    // Throws, because every selected route is currently unreachable --
    // and the point stands regardless: nothing was revoked. A route
    // disabled for maintenance is still selected, so the credential on
    // it survives the outage.
    await expect(service.provisionAll("sub-1")).rejects.toBeInstanceOf(BadRequestException);

    expect(remove).not.toHaveBeenCalled();
  });

  it("does not revoke when every selected route is unavailable", async () => {
    // Ordered after the "none available" throw, so an outage cannot
    // strip a paying subscription of everything it holds. The customer
    // keeps what they have until one of its routes is back.
    const { service, remove } = serviceFor({
      selected: ["relay-1"],
      routes: [],
      existing: [{ id: "pu-direct", routeId: "direct-1" }],
    });

    await expect(service.provisionAll("sub-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(remove).not.toHaveBeenCalled();
  });
});
