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
