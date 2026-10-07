import { Logger } from "@nestjs/common";
import { AgentGatewayService, ROUTE_ACK_PREFIX } from "./agent-gateway.service";

/**
 * The ENTRY half of a relay route's health.
 *
 * A relay route is two hot-added things on two nodes. The exit's half
 * (the uplink credential) has recorded its acks on the Route since
 * 2026-08-23. The entry's half -- the outbound, the routing rule and,
 * for a WireGuard, OpenVPN or IKEv2 entry, the policy route into the
 * relay tunnel -- was re-asserted every minute and its rejection only
 * logged, so a relay that could not rebuild it (ir1 with no relay-tun
 * device, 2026-08-14) kept the route reporting ONLINE.
 */
describe("relay route entry health", () => {
  type Ack = { commandId: string; success: boolean; error: string };

  function build() {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const routeRow = {
      id: "route-fr",
      uplinkCredentialsJson: JSON.stringify({ uuid: "uplink-uuid", flow: "xtls-rprx-vision" }),
      entryProtocolConfig: {
        nodeId: "ir1",
        protocol: "IKEV2",
        inboundTag: null,
        listenPort: 500,
        transport: null,
        publicParamsJson: { pool: "10.20.0.0/24" },
      },
      exitProtocolConfig: {
        nodeId: "france-1",
        protocol: "XRAY_VLESS_REALITY",
        transport: "TCP",
        inboundTag: null,
        listenPort: 443,
        publicParamsJson: {},
        node: { id: "france-1", publicIp: "203.0.113.30" },
      },
    };

    // The row as the database holds it, and a where-clause that honours
    // the node a write is scoped to -- so a write from the wrong node
    // visibly changes nothing, rather than passing on the call's shape.
    const stored: Record<string, unknown> = {};
    const updateMany = jest.fn(
      ({ where, data }: { where: { id: string; entryProtocolConfig?: { is: { nodeId: string } } }; data: object }) => {
        const entryNode = where.entryProtocolConfig?.is.nodeId;
        if (where.id !== routeRow.id || (entryNode !== undefined && entryNode !== routeRow.entryProtocolConfig.nodeId)) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(stored, data);
        return Promise.resolve({ count: 1 });
      },
    );
    const commands: Record<string, { nodeId: string; type: string; payloadJson: unknown }> = {};
    const prisma = {
      route: { findMany: jest.fn().mockResolvedValue([routeRow]), updateMany },
      protocolUser: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      agentCommand: {
        findFirst: jest.fn(({ where }: { where: { id: string; nodeId: string } }) => {
          const c = commands[where.id];
          return Promise.resolve(c && c.nodeId === where.nodeId ? c : null);
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const registry = { connectedNodeIds: jest.fn().mockReturnValue(["ir1"]) };
    const service = new AgentGatewayService(prisma as never, {} as never, registry as never, {} as never, {} as never, {} as never);

    const written: { nodeId: string; id: string; type: string }[] = [];
    (service as unknown as Record<string, unknown>).writeCommand = (nodeId: string, id: string, type: string) => {
      written.push({ nodeId, id, type });
      return true;
    };
    const ack = (nodeId: string, a: Ack) =>
      (service as unknown as { handleCommandAck(n: string, a: Ack): Promise<void> }).handleCommandAck(nodeId, a);
    const sweep = () =>
      (service as unknown as { reassertRoutesOnConnectedNodes(): Promise<void> }).reassertRoutesOnConnectedNodes();

    return { service, stored, written, ack, sweep, commands };
  }

  afterEach(() => jest.restoreAllMocks());

  it("marks the entry asserted once the relay acks the sweep's CONFIGURE_ROUTE", async () => {
    const { stored, written, ack, sweep } = build();
    await sweep();
    const entry = written.find((w) => w.nodeId === "ir1" && w.type === "CONFIGURE_ROUTE");
    expect(entry?.id).toBe(`${ROUTE_ACK_PREFIX}route-fr`);
    expect(stored.entryAssertedAt).toBeUndefined();

    await ack("ir1", { commandId: entry!.id, success: true, error: "" });
    expect(stored.entryAssertedAt).toBeInstanceOf(Date);
    expect(stored.entryLastError).toBeNull();
  });

  it("records a rejection instead of only logging it", async () => {
    const { stored, ack } = build();
    await ack("ir1", {
      commandId: `${ROUTE_ACK_PREFIX}route-fr`,
      success: false,
      error: "ip route (bridge 10.20.0.0/24 through relay-tun): Cannot find device \"relay-tun\"",
    });
    expect(stored.entryLastError).toContain("Cannot find device");
    // Not stamped: three missed sweeps and the route reads as down.
    expect(stored.entryAssertedAt).toBeUndefined();
  });

  it("takes the entry's word only from the entry node", async () => {
    const { stored, ack } = build();
    await ack("france-1", { commandId: `${ROUTE_ACK_PREFIX}route-fr`, success: true, error: "" });
    expect(stored.entryAssertedAt).toBeUndefined();
  });

  it("counts a stored CONFIGURE_ROUTE's ack too -- creation, and the re-assert on reconnect", async () => {
    const { stored, ack, commands } = build();
    commands["cmd-1"] = { nodeId: "ir1", type: "CONFIGURE_ROUTE", payloadJson: { routeId: "route-fr" } };
    await ack("ir1", { commandId: "cmd-1", success: false, error: "AddOutbound: connection refused" });
    expect(stored.entryLastError).toContain("connection refused");

    commands["cmd-2"] = { nodeId: "ir1", type: "CONFIGURE_ROUTE", payloadJson: { routeId: "route-fr" } };
    await ack("ir1", { commandId: "cmd-2", success: true, error: "" });
    expect(stored.entryAssertedAt).toBeInstanceOf(Date);
    expect(stored.entryLastError).toBeNull();
  });
});
