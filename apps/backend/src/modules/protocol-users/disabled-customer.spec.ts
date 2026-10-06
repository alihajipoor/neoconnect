import { ProtocolUsersService } from "./protocol-users.service";
import { liveCredentialWhere } from "./live-credentials";
import { deviceSlotsStub } from "../../../test/device-slots-stub";

/** A customer an operator has DISABLED.
 *
 * The status used to change nothing downstream: the credentials stayed on
 * their nodes (the 60 s re-assert kept them there), switch-route still
 * handed out and created credentials, and the list still served them. */
describe("a disabled customer's credentials", () => {
  it("are switched off on their nodes without their rows being rewritten", async () => {
    const prisma = {
      protocolUser: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "pu-1",
            nodeId: "node-1",
            protocol: "XRAY_VLESS_TLS",
            externalUserId: "uuid-1",
            protocolConfig: { transport: "WS", inboundTag: null },
          },
          {
            id: "pu-2",
            nodeId: "node-2",
            protocol: "WIREGUARD",
            externalUserId: "peer-2",
            protocolConfig: { transport: "TCP", inboundTag: null },
          },
        ]),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const agentGateway = { enqueueCommand: jest.fn().mockResolvedValue(undefined) };
    const service = new ProtocolUsersService(prisma as never, agentGateway as never, deviceSlotsStub() as never);

    await expect(service.switchOffCustomer("cust-1")).resolves.toEqual({ switchedOff: 2, failed: 0 });

    expect(prisma.protocolUser.findMany.mock.calls[0][0].where).toEqual({
      subscription: { customerId: "cust-1" },
      status: "ACTIVE",
    });
    expect(agentGateway.enqueueCommand.mock.calls).toEqual([
      ["node-1", "DISABLE_USER", { protocol: "XRAY_VLESS_TLS", transport: "WS", externalUserId: "uuid-1" }],
      ["node-2", "DISABLE_USER", { protocol: "WIREGUARD", transport: "TCP", externalUserId: "peer-2" }],
    ]);
    // The status column is what lets re-enabling restore exactly what was
    // on before, through the re-assert.
    expect(prisma.protocolUser.update).not.toHaveBeenCalled();
    expect(prisma.protocolUser.updateMany).not.toHaveBeenCalled();
  });

  it("keep going when one node cannot be told", async () => {
    const prisma = {
      protocolUser: {
        findMany: jest.fn().mockResolvedValue([
          { id: "pu-1", nodeId: "n1", protocol: "WIREGUARD", externalUserId: "a", protocolConfig: { transport: "TCP", inboundTag: null } },
          { id: "pu-2", nodeId: "n2", protocol: "WIREGUARD", externalUserId: "b", protocolConfig: { transport: "TCP", inboundTag: null } },
        ]),
      },
    };
    const agentGateway = { enqueueCommand: jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined) };
    const service = new ProtocolUsersService(prisma as never, agentGateway as never, deviceSlotsStub() as never);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);

    await expect(service.switchOffCustomer("cust-1")).resolves.toEqual({ switchedOff: 1, failed: 1 });
  });

  it("are not live, so the re-assert stops putting them back and restores them when the account is ACTIVE", () => {
    expect(liveCredentialWhere(new Date(0))).toMatchObject({
      subscription: { status: "ACTIVE", customer: { status: "ACTIVE" } },
    });
  });

  function serviceFor(customerStatus: string) {
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sub-1",
          customerId: "cust-1",
          status: "ACTIVE",
          customer: { status: customerStatus },
          plan: { name: "Pro", protocolsAllowed: ["WIREGUARD"], allowedRoutes: [{ id: "route-1" }] },
        }),
      },
      route: {
        findUnique: jest.fn().mockResolvedValue({
          id: "route-1",
          isEnabled: true,
          entryProtocolConfig: { protocol: "WIREGUARD", node: {} },
        }),
        findMany: jest.fn().mockResolvedValue([{ id: "route-1" }]),
      },
      protocolUser: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ id: "existing" }),
        create: jest.fn(),
      },
    };
    const agentGateway = { enqueueCommand: jest.fn() };
    const service = new ProtocolUsersService(prisma as never, agentGateway as never, deviceSlotsStub() as never);
    return { service, prisma, agentGateway };
  }

  it("are never created", async () => {
    const { service, prisma, agentGateway } = serviceFor("DISABLED");

    await expect(service.create({ subscriptionId: "sub-1", routeId: "route-1" })).rejects.toThrow(/disabled/);
    await expect(service.provisionAll("sub-1")).resolves.toEqual({ created: [], revoked: [], failed: [] });
    expect(prisma.protocolUser.create).not.toHaveBeenCalled();
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("are not handed out by switch-route, existing or new", async () => {
    const { service, prisma } = serviceFor("DISABLED");

    await expect(service.switchRoute("sub-1", "route-1")).rejects.toThrow(/disabled/);
    expect(prisma.protocolUser.findFirst).not.toHaveBeenCalled();
  });
});
