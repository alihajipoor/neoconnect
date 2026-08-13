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
        findUnique: jest.fn().mockResolvedValue({ id: "sub-1", plan: { id: "p1", ...plan } }),
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
        findUnique: jest.fn().mockResolvedValue({ id: "sub-1", plan: { name: "Ultimate", relayOnly } }),
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
});
