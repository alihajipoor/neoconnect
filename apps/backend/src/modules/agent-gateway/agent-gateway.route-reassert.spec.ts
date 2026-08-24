import { AgentGatewayService } from "./agent-gateway.service";

/**
 * Route re-assertion, which had no test at all despite being the only
 * thing standing between an Xray restart and a relay customer's traffic
 * leaving from the relay.
 *
 * Why that matters more than an ordinary outage: a relay's outbound and
 * routing rule are hot-added over Xray's gRPC API and live only in the
 * running process. A restart empties them, and with no rule matching the
 * entry inbound the traffic does not stop -- it falls through to the
 * relay's own `direct` outbound and egresses at the relay. A customer
 * routing through Iran to get out of Iran comes out in Iran, with the app
 * showing a healthy connection.
 *
 * ir1's access log recorded exactly one such session, 2026-08-13
 * 23:50:51, on a real customer's credential.
 */
describe("AgentGatewayService route re-assertion", () => {
  function buildRoute(over: Record<string, unknown> = {}) {
    return {
      id: "route-1",
      uplinkCredentialsJson: JSON.stringify({ uuid: "u-1" }),
      entryProtocolConfig: {
        nodeId: "node-1",
        protocol: "XRAY_VLESS_REALITY",
        inboundTag: "vless-in",
        listenPort: 443,
        transport: "TCP",
        publicParamsJson: {},
      },
      exitProtocolConfig: {
        nodeId: "exit-node-1",
        protocol: "XRAY_VLESS_REALITY",
        transport: "TCP",
        inboundTag: null,
        listenPort: 443,
        publicParamsJson: {},
        node: { id: "exit-node-1", publicIp: "204.168.161.100" },
      },
      ...over,
    };
  }

  function build(routes: unknown[], connected: string[] = ["node-1"]) {
    const prisma = {
      route: {
        findMany: jest.fn().mockResolvedValue(routes),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      protocolUser: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const registry = { connectedNodeIds: jest.fn().mockReturnValue(connected) };

    const service = new AgentGatewayService(
      prisma as never,
      {} as never,
      registry as never,
      {} as never,
      {} as never,
      {} as never,
    );

    // writeCommand pushes straight onto the live stream; there is no
    // stream here, so capture what it was asked to send.
    const written: { nodeId: string; type: string; payload: unknown }[] = [];
    (service as unknown as Record<string, unknown>).writeCommand = (
      nodeId: string,
      _id: string,
      type: string,
      payload: unknown,
    ) => {
      written.push({ nodeId, type, payload });
      // Mirrors the real writeCommand's contract: true means "went onto a
      // live stream". Returning undefined here made every uplink assert
      // look undeliverable.
      return connected.includes(nodeId);
    };

    return { service, prisma, written };
  }

  function reassertRoutes(service: AgentGatewayService, nodeId: string): Promise<void> {
    return (
      service as unknown as {
        reassertConfiguredRoutes(id: string, o: { persist: boolean }): Promise<void>;
      }
    ).reassertConfiguredRoutes(nodeId, { persist: false });
  }

  it("re-sends CONFIGURE_ROUTE for a relayed route", async () => {
    const { service, written } = build([buildRoute()]);

    await reassertRoutes(service, "node-1");

    const configure = written.filter((w) => w.type === "CONFIGURE_ROUTE");
    expect(configure).toHaveLength(1);
    expect(configure[0].payload).toEqual(
      expect.objectContaining({ routeId: "route-1", entryInboundTag: "vless-in" }),
    );
  });

  it("carries the entry inbound tag, so a relay's France rule is not rebuilt on its Finland listener", async () => {
    // A relay runs one inbound per exit. Re-asserting without the tag
    // would point the restored rule at the wrong exit -- the customer
    // would be tunnelled, and to the wrong country, which is the failure
    // this whole mechanism exists to avoid.
    const { service, written } = build([
      buildRoute({
        id: "route-fr",
        entryProtocolConfig: {
          nodeId: "node-1",
          protocol: "XRAY_VLESS_REALITY",
          inboundTag: "vless-fr-in",
          listenPort: 8444,
          transport: "TCP",
          publicParamsJson: {},
        },
      }),
    ]);

    await reassertRoutes(service, "node-1");

    const configure = written.filter((w) => w.type === "CONFIGURE_ROUTE");
    expect(configure[0].payload).toEqual(expect.objectContaining({ entryInboundTag: "vless-fr-in" }));
  });

  it("asks only for enabled, relayed routes entering this node", async () => {
    // The filter is the guard: a disabled route must not be restored, and
    // a direct route installs no rule at all, so restoring one would be
    // meaningless traffic to the agent.
    const { service, prisma } = build([]);

    await reassertRoutes(service, "node-1");

    expect(prisma.route.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isEnabled: true,
          exitProtocolConfigId: { not: null },
          entryProtocolConfig: { nodeId: "node-1" },
        }),
      }),
    );
  });

  it("skips a route whose uplink credential is missing rather than sending a broken one", async () => {
    const { service, written } = build([buildRoute({ uplinkCredentialsJson: null })]);

    await reassertRoutes(service, "node-1");

    expect(written).toHaveLength(0);
  });

  it("the user sweep does not also re-send routes", async () => {
    // The mirror of the test below, and the reason both exist: the two
    // sweeps run on the same interval now, so if either one starts doing
    // the other's work every CONFIGURE_ROUTE goes out twice a minute for
    // nothing. Cheap today at a dozen routes; not a habit to acquire.
    const { service, prisma } = build([buildRoute()]);

    await (
      service as unknown as { reassertAllConnectedNodes(): Promise<void> }
    ).reassertAllConnectedNodes();

    expect(prisma.protocolUser.findMany).toHaveBeenCalled();
    expect(prisma.route.findMany).not.toHaveBeenCalled();
  });

  it("the fast sweep restores routes without re-sending every user", async () => {
    // The reason routes get their own interval. Re-asserting users is one
    // message per user per sweep; running that at the route cadence would
    // multiply it tenfold to shorten a window only routes are exposed to.
    const { service, prisma, written } = build([buildRoute()]);

    await (
      service as unknown as { reassertRoutesOnConnectedNodes(): Promise<void> }
    ).reassertRoutesOnConnectedNodes();

    // Both halves of the route, and nothing else: the entry's rule and
    // the exit's uplink credential.
    expect(written.map((w) => `${w.nodeId}:${w.type}`).sort()).toEqual([
      "exit-node-1:CREATE_USER",
      "node-1:CONFIGURE_ROUTE",
    ]);
    expect(prisma.protocolUser.findMany).not.toHaveBeenCalled();
  });
});
