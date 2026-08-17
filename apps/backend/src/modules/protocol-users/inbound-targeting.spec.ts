import { ProtocolUsersService } from "./protocol-users.service";
import { encryptCredentials } from "./credentials-crypto";

/**
 * Commands must name the inbound a credential actually lives on.
 *
 * A relay runs one inbound per exit it forwards to, so on those nodes the
 * protocol no longer identifies a listener. Two failure shapes follow if
 * a command omits the tag, and both are silent:
 *
 *  - create() adds the customer to the wrong inbound. The credential
 *    authenticates, and their traffic leaves through the wrong country.
 *  - remove()/setEnabled() act on the wrong inbound. The credential keeps
 *    working on the one it really lives on -- so a quota suspension or an
 *    account deletion does not actually cut anyone off.
 *
 * The second is the one worth pinning hardest: it looks like success at
 * every layer above the engine.
 */
describe("commands name the inbound", () => {
  const ENCRYPTED = encryptCredentials({ uuid: "11111111-2222-3333-4444-555555555555", flow: "xtls-rprx-vision" });

  const CONFIG = {
    id: "cfg-fr",
    nodeId: "n-relay",
    protocol: "XRAY_VLESS_REALITY",
    transport: "TCP",
    listenPort: 8443,
    publicParamsJson: { realityPublicKey: "k", shortIds: ["ab"], serverName: "cloudflare.com", dest: "cloudflare.com:443" },
    node: { publicIp: "185.222.28.186" },
  };

  function serviceFor(inboundTag: string | null) {
    const protocolConfig = { ...CONFIG, inboundTag };
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({ id: "sub-1", plan: { name: "Ultimate", allowedRoutes: [{ id: "route-1" }] } }),
      },
      route: {
        findUnique: jest.fn().mockResolvedValue({
          id: "route-1",
          name: "ir1 relay -> france-1",
          isEnabled: true,
          exitProtocolConfigId: "exit-fr",
          entryProtocolConfig: protocolConfig,
        }),
      },
      protocolUser: {
        create: jest.fn().mockResolvedValue({ id: "pu-1", credentialsJson: ENCRYPTED }),
        findUnique: jest.fn().mockResolvedValue({
          id: "pu-1",
          nodeId: "n-relay",
          protocol: "XRAY_VLESS_REALITY",
          externalUserId: "ext-1",
          credentialsJson: ENCRYPTED,
          protocolConfig: { transport: "TCP", inboundTag },
        }),
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({ id: "pu-1", credentialsJson: ENCRYPTED }),
      },
    };
    const agentGateway = { enqueueCommand: jest.fn().mockResolvedValue(undefined) };
    return { service: new ProtocolUsersService(prisma as never, agentGateway as never), agentGateway };
  }

  function payloadOf(agentGateway: { enqueueCommand: jest.Mock }, type: string) {
    const call = agentGateway.enqueueCommand.mock.calls.find((c) => c[1] === type);
    return call?.[2] as Record<string, unknown> | undefined;
  }

  it("CREATE_USER carries the tag when the config has one", async () => {
    const { service, agentGateway } = serviceFor("vless-fr-in");
    await service.create({ subscriptionId: "sub-1", routeId: "route-1" });
    expect(payloadOf(agentGateway, "CREATE_USER")).toEqual(expect.objectContaining({ inboundTag: "vless-fr-in" }));
  });

  it("CREATE_USER omits the field entirely when the config has no tag", async () => {
    // Not `inboundTag: null` -- absent. The payload has to stay
    // byte-identical to what every non-relay node already receives, and
    // the agent reads absent as "the inbound you were started with".
    const { service, agentGateway } = serviceFor(null);
    await service.create({ subscriptionId: "sub-1", routeId: "route-1" });
    expect(payloadOf(agentGateway, "CREATE_USER")).not.toHaveProperty("inboundTag");
  });

  it("DELETE_USER carries the tag, so a deletion reaches the right listener", async () => {
    const { service, agentGateway } = serviceFor("vless-fr-in");
    await service.remove("pu-1");
    expect(payloadOf(agentGateway, "DELETE_USER")).toEqual(
      expect.objectContaining({ inboundTag: "vless-fr-in", transport: "TCP" }),
    );
  });

  it("DISABLE_USER carries the tag, so a quota suspension actually suspends", async () => {
    const { service, agentGateway } = serviceFor("vless-fr-in");
    await service.setEnabled("pu-1", false);
    expect(payloadOf(agentGateway, "DISABLE_USER")).toEqual(
      expect.objectContaining({ inboundTag: "vless-fr-in", transport: "TCP" }),
    );
  });
});
