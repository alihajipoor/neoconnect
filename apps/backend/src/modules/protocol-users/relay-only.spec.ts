import { BadRequestException } from "@nestjs/common";
import { ProtocolUsersService } from "./protocol-users.service";

/**
 * The relay/direct split, pinned in both directions.
 *
 * These exist because the expensive failure is silent. provisionAll()
 * hands every eligible Route to every subscription, so without the
 * filter the first Iran relay route would be provisioned to all live
 * customers within one sweep -- relayed traffic crosses two servers and
 * the Iran side costs more per gigabyte, so the bill arrives before
 * anyone notices the behaviour.
 *
 * Asserting on the WHERE clause rather than on rows is deliberate: the
 * filter is the whole mechanism, and a test that went through a real
 * database would prove it for the routes that happened to exist that
 * day rather than for the rule.
 */
describe("provisionAll: relay-only plans", () => {
  function serviceFor(plan: { name: string; relayOnly: boolean; protocolsAllowed: string[] }) {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({ id: "sub-1", plan: { id: "p1", allowedRoutes: [], ...plan } }),
      },
      route: { findMany },
      protocolUser: { findMany: jest.fn().mockResolvedValue([]) },
    };
    // Two args, matching provision-all.spec.ts -- the sibling spec for
    // this same method, whose pattern this follows rather than inventing
    // a second one.
    const service = new ProtocolUsersService(prisma as never, {} as never);
    jest.spyOn(service, "create").mockImplementation(({ routeId }) => Promise.resolve({ routeId } as never));
    return { service, findMany };
  }

  const NORMAL = { name: "Starter", relayOnly: false, protocolsAllowed: ["WIREGUARD"] };
  const RELAY = { name: "Ultimate", relayOnly: true, protocolsAllowed: ["WIREGUARD"] };

  it("a normal plan asks only for DIRECT routes", async () => {
    // The expensive direction: without this, every Starter and Pro
    // customer lands on the Iran relay the moment one exists.
    const { service, findMany } = serviceFor(NORMAL);
    await service.provisionAll("sub-1").catch(() => undefined);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ exitProtocolConfigId: null }),
      }),
    );
  });

  it("a relay-only plan asks only for RELAYED routes", async () => {
    const { service, findMany } = serviceFor(RELAY);
    await service.provisionAll("sub-1").catch(() => undefined);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ exitProtocolConfigId: { not: null } }),
      }),
    );
  });

  it("a relay-only plan with no relay route FAILS rather than provisioning nothing", async () => {
    // Silence would look like a working subscription that never
    // connects, for a customer who has paid. An error at least reaches
    // the operator and the purchase flow.
    const { service } = serviceFor(RELAY);
    await expect(service.provisionAll("sub-1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a normal plan with no route does NOT fail", async () => {
    // Only the relay case is an error. A normal plan legitimately has
    // nothing to provision when no route matches its protocols, and
    // throwing there would break ordinary purchases.
    const { service } = serviceFor(NORMAL);
    await expect(service.provisionAll("sub-1")).resolves.toEqual([]);
  });
});

/**
 * The same rule at the chokepoint every provisioning path goes through.
 *
 * provisionAll's filter decides what gets OFFERED. It does not decide
 * what can be created: POST /protocol-users, the picker's switchRoute,
 * the admin panel and renewal all call create() with a routeId directly.
 * Verified against the live backend on 2026-08-13 -- a direct route on a
 * relay-only plan returned 201 with only the filter in place.
 */
describe("create: relay-only plans", () => {
  function serviceFor(relayOnly: boolean, exitProtocolConfigId: string | null) {
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({ id: "sub-1", plan: { name: "Ultimate", relayOnly, allowedRoutes: [] } }),
      },
      route: {
        findUnique: jest.fn().mockResolvedValue({
          id: "route-1",
          name: exitProtocolConfigId ? "ir1 relay -> finland1" : "finland1 direct",
          isEnabled: true,
          exitProtocolConfigId,
          entryProtocolConfig: { id: "cfg-1", nodeId: "n1", protocol: "XRAY_VLESS_REALITY", node: {} },
        }),
      },
      protocolUser: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    };
    const agentGateway = { enqueueCommand: jest.fn().mockResolvedValue(undefined) };
    return {
      service: new ProtocolUsersService(prisma as never, agentGateway as never),
      prisma,
      agentGateway,
    };
  }

  it("refuses a DIRECT route on a relay-only plan", async () => {
    const { service, prisma, agentGateway } = serviceFor(true, null);
    await expect(service.create({ subscriptionId: "sub-1", routeId: "route-1" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // No row written and no CREATE_USER sent to a node -- a rejected
    // request must not leave an account running on an engine.
    expect(prisma.protocolUser.create).not.toHaveBeenCalled();
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("allows a RELAYED route on a relay-only plan", async () => {
    const { service, prisma } = serviceFor(true, "exit-cfg-1");
    await service.create({ subscriptionId: "sub-1", routeId: "route-1" }).catch(() => undefined);
    expect(prisma.protocolUser.create).toHaveBeenCalled();
  });

  it("leaves normal plans on direct routes alone", async () => {
    // The regression that would matter most: every existing customer is
    // on a normal plan and a direct route.
    const { service, prisma } = serviceFor(false, null);
    await service.create({ subscriptionId: "sub-1", routeId: "route-1" }).catch(() => undefined);
    expect(prisma.protocolUser.create).toHaveBeenCalled();
  });

  it("refuses a RELAYED route on a normal plan", async () => {
    // The half that was missing. provisionAll has always filtered both
    // ways, but create() only ever checked the relayOnly side, so the
    // expensive direction stayed reachable by asking for it directly:
    // a Starter or Pro subscription provisioned onto the Iran relay,
    // crossing two servers at double the cost per gigabyte for someone
    // who never bought that plan.
    const { service, prisma, agentGateway } = serviceFor(false, "exit-cfg-1");
    await expect(service.create({ subscriptionId: "sub-1", routeId: "route-1" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.protocolUser.create).not.toHaveBeenCalled();
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });
});

/**
 * The per-plan route selection.
 *
 * Empty means no restriction, and that asymmetry is the whole safety
 * property: every plan that existed before this feature has an empty
 * selection, so treating empty as "nothing allowed" would strip the
 * entire customer base at once. The first test below is the one that
 * would catch that.
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

  it("an EMPTY selection restricts nothing", async () => {
    // The migration-safety case. Every pre-existing plan has an empty
    // selection; if that were read as `id: { in: [] }` the query would
    // match no route and every customer would be reconciled down to
    // nothing on the next sweep.
    const { service, findMany } = serviceFor([]);
    await service.provisionAll("sub-1").catch(() => undefined);

    const where = findMany.mock.calls[0][0].where;
    expect(where.id).toBeUndefined();
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

  it("does not let a selection override the relay rule", async () => {
    // Selecting routes narrows; it never widens. A relay route picked on
    // a non-relay plan must still be refused, or the setting becomes a
    // way around the split that exists to stop Starter customers landing
    // on Iran bandwidth.
    const { service, prisma } = serviceFor(["route-1"], "route-1");
    prisma.route.findUnique.mockResolvedValue({
      id: "route-1",
      name: "ir1 relay -> finland1",
      isEnabled: true,
      exitProtocolConfigId: "exit-cfg-1",
      entryProtocolConfig: { id: "cfg-1", nodeId: "n1", protocol: "XRAY_VLESS_REALITY", node: {} },
    });

    await expect(service.create({ subscriptionId: "sub-1", routeId: "route-1" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.protocolUser.create).not.toHaveBeenCalled();
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
    relayOnly: boolean;
    routes: { id: string; isEnabled?: boolean; entryEnabled?: boolean }[];
    existing: { id: string; routeId: string }[];
  }) {
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sub-1",
          plan: { name: opts.relayOnly ? "Ultimate" : "Starter", relayOnly: opts.relayOnly, protocolsAllowed: ["WIREGUARD"], allowedRoutes: [] },
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
      relayOnly: true,
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
      relayOnly: false,
      routes: [{ id: "direct-1", isEnabled: false }],
      existing: [{ id: "pu-direct", routeId: "direct-1" }],
    });

    await service.provisionAll("sub-1");

    expect(remove).not.toHaveBeenCalled();
  });

  it("does not revoke when a relay-only plan has no relay route available", async () => {
    // Ordered after the "none available" throw, so an outage cannot
    // strip a paying subscription of everything it holds. The customer
    // keeps what they have until a relay route is back.
    const { service, remove } = serviceFor({
      relayOnly: true,
      routes: [],
      existing: [{ id: "pu-direct", routeId: "direct-1" }],
    });

    await expect(service.provisionAll("sub-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(remove).not.toHaveBeenCalled();
  });
});
