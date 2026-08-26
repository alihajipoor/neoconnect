import { BadRequestException } from "@nestjs/common";
import { RoutesService } from "./routes.service";

/**
 * A relay entry may serve exactly one exit.
 *
 * This is pinned because the failure it prevents is invisible. Xray's
 * routing rule for a relayed route matches on the entry inbound's tag
 * and nothing else, so a second relayed route on the same entry config
 * produces a second rule with identical match criteria -- and Xray takes
 * the first. The second route still gets created, still provisions
 * credentials, and still appears in the customer's location picker,
 * while its traffic leaves through the first route's exit.
 *
 * Measured, not reasoned: on 2026-08-13 ir1 was given routes to both
 * finland1 and france-1, and a credential issued on the FRANCE route
 * exited at finland1's address. Nothing in the route rows, the command
 * acks or the agent logs said so.
 */
describe("RoutesService.create: one exit per relay entry", () => {
  const ENTRY_ID = "entry-cfg-1";

  function serviceFor(existingRelayedRoute: { id: string; name: string } | null) {
    const findFirst = jest.fn().mockResolvedValue(existingRelayedRoute);
    const prisma = {
      protocolConfig: {
        findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          where.id === ENTRY_ID
            ? Promise.resolve({ id: ENTRY_ID, protocol: "XRAY_VLESS_REALITY", nodeId: "n-relay", node: { role: "RELAY" } })
            : Promise.resolve({
                id: where.id,
                protocol: "XRAY_VLESS_REALITY",
                nodeId: "n-exit",
                listenPort: 443,
                publicParamsJson: {},
                node: { role: "STANDALONE", publicIp: "203.0.113.9" },
              }),
        ),
      },
      route: { findFirst, create: jest.fn().mockResolvedValue({ id: "new-route", isEnabled: true }) },
    };
    const agentGateway = { enqueueCommand: jest.fn().mockResolvedValue(undefined) };
    const service = new RoutesService(prisma as never, agentGateway as never, {} as never, {
      get: () => undefined,
    } as never);
    // backfill re-reads the route with includes the stub does not model;
    // it is not what these tests are about.
    jest.spyOn(service as never as { backfillExistingSubscriptions: () => Promise<void> }, "backfillExistingSubscriptions")
      .mockResolvedValue(undefined);
    return { service, prisma, agentGateway, findFirst };
  }

  const dto = { name: "ir1 relay -> france-1", entryProtocolConfigId: ENTRY_ID, exitProtocolConfigId: "exit-cfg-fr" };

  it("refuses a second relayed route on an entry that already relays", async () => {
    const { service, agentGateway, prisma } = serviceFor({ id: "r1", name: "ir1 relay -> finland1" });

    await expect(service.create(dto)).rejects.toBeInstanceOf(BadRequestException);

    // The point is that nothing is half-built: no route row, and in
    // particular no uplink user left behind on the exit node.
    expect(prisma.route.create).not.toHaveBeenCalled();
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("names the route already using that entry, so the operator can act on it", async () => {
    const { service } = serviceFor({ id: "r1", name: "ir1 relay -> finland1" });
    await expect(service.create(dto)).rejects.toThrow(/ir1 relay -> finland1/);
  });

  it("allows the first relayed route on a free entry", async () => {
    const { service, prisma } = serviceFor(null);
    await expect(service.create(dto)).resolves.toEqual(expect.objectContaining({ id: "new-route" }));
    expect(prisma.route.create).toHaveBeenCalled();
  });

  it("only counts RELAYED routes as conflicting, not direct ones", async () => {
    // A direct route installs no Xray routing rule at all, so it cannot
    // collide with anything. Treating it as a conflict would block the
    // ordinary case of a node offering both a direct and a relayed path.
    const { service, findFirst } = serviceFor(null);
    await service.create(dto);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ exitProtocolConfigId: { not: null } }),
      }),
    );
  });
});
