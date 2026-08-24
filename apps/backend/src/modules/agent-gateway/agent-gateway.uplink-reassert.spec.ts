import { AgentGatewayService, UPLINK_ACK_PREFIX } from "./agent-gateway.service";

/**
 * The restart-then-reassert cycle for a relay route's UPLINK credential.
 *
 * A relay route is two hot-added things on two different nodes. The entry
 * node holds the outbound and the routing rule; the EXIT node holds one
 * shared credential -- `route:<id>` -- on its inbound, which is the
 * identity the relay authenticates with. Both live only in the running
 * Xray process, and both are erased by a restart.
 *
 * Only the entry half was ever re-asserted. The uplink was created once,
 * by RoutesService.create, and has no ProtocolUser row, so the user sweep
 * could not see it either. The result, measured on 2026-08-23: france-1
 * had restarted Xray on 08-19 and finland1 on 08-20, both exits held
 * exactly their direct customers and zero `route:` users, and all
 * thirteen relay routes were dead. The entry half had been re-asserted
 * faithfully the entire time -- ir1 held every outbound and rule, aimed
 * at a credential the exits no longer recognised. france-1's access log:
 * "rejected proxy/vless/encoding: invalid request user id".
 *
 * This models the exit as what it is -- a set of emails that a restart
 * empties -- so the test fails if the sweep stops re-creating the uplink,
 * rather than passing on the shape of a message nobody applies.
 */
describe("relay uplink survives an exit-node engine restart", () => {
  /** A stand-in for the exit node's Xray inbound: the set of user emails
   * currently installed on it. `restart()` is what an Xray restart
   * actually does to hot-added users. */
  class FakeExitInbound {
    users = new Set<string>();
    restart() {
      this.users.clear();
    }
    apply(type: string, payload: { externalUserId?: string }) {
      if (type === "CREATE_USER" && payload.externalUserId) this.users.add(payload.externalUserId);
      if (type === "DELETE_USER" && payload.externalUserId) this.users.delete(payload.externalUserId);
    }
  }

  function build(opts: { exitConnected?: boolean } = {}) {
    const exit = new FakeExitInbound();
    const routeRow = {
      id: "route-fr",
      uplinkCredentialsJson: JSON.stringify({ uuid: "uplink-uuid", flow: "xtls-rprx-vision" }),
      entryProtocolConfig: {
        nodeId: "ir1",
        protocol: "XRAY_VLESS_REALITY",
        inboundTag: "vless-fr-in",
        listenPort: 8444,
        transport: "TCP",
        publicParamsJson: {},
      },
      exitProtocolConfig: {
        nodeId: "france-1",
        protocol: "XRAY_VLESS_REALITY",
        transport: "TCP",
        inboundTag: null,
        listenPort: 443,
        publicParamsJson: {},
        node: { id: "france-1", publicIp: "104.105.205.233" },
      },
    };

    const stored: Record<string, unknown> = {};
    const prisma = {
      route: {
        findMany: jest.fn().mockResolvedValue([routeRow]),
        updateMany: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          Object.assign(stored, data);
          return Promise.resolve({ count: 1 });
        }),
      },
      protocolUser: { findMany: jest.fn().mockResolvedValue([]) },
      agentCommand: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const registry = { connectedNodeIds: jest.fn().mockReturnValue(["ir1"]) };

    const service = new AgentGatewayService(
      prisma as never,
      {} as never,
      registry as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const acks: { commandId: string; success: boolean; error: string }[] = [];
    const exitConnected = opts.exitConnected ?? true;
    (service as unknown as Record<string, unknown>).writeCommand = (
      nodeId: string,
      id: string,
      type: string,
      payload: { externalUserId?: string },
    ) => {
      if (nodeId === "france-1") {
        if (!exitConnected) return false;
        exit.apply(type, payload);
        // The agent acks what it applied. Nothing in the service is
        // allowed to record success without one.
        acks.push({ commandId: id, success: true, error: "" });
      }
      return true;
    };

    const sweep = () =>
      (
        service as unknown as {
          reassertRoutesOnConnectedNodes(): Promise<void>;
        }
      ).reassertRoutesOnConnectedNodes();

    const drainAcks = async () => {
      const pending = acks.splice(0);
      for (const ack of pending) {
        await (
          service as unknown as {
            handleCommandAck(a: { commandId: string; success: boolean; error: string }): Promise<void>;
          }
        ).handleCommandAck(ack);
      }
    };

    return { service, exit, sweep, drainAcks, stored, prisma, acks };
  }

  it("re-creates the uplink the exit lost, and the sweep alone is enough", async () => {
    const { exit, sweep } = build();

    // Steady state: the route was created, so the exit holds the uplink.
    exit.users.add("route:route-fr");

    // What actually happened on france-1 on 2026-08-19.
    exit.restart();
    expect(exit.users.has("route:route-fr")).toBe(false);

    await sweep();

    expect(exit.users.has("route:route-fr")).toBe(true);
  });

  it("the entry half alone leaves the exit empty", async () => {
    // The negative control, and the whole point of modelling the exit as
    // a set rather than counting messages. This is precisely what the
    // code did before: CONFIGURE_ROUTE to the entry, nothing to the exit.
    // If a future change makes the sweep entry-only again, the test above
    // has to fail -- this shows it can.
    const { exit, service } = build();
    exit.restart();

    // Stand in for the old behaviour: drop anything addressed to the exit.
    (service as unknown as Record<string, unknown>).writeCommand = (nodeId: string) => nodeId === "ir1";

    await (
      service as unknown as {
        reassertConfiguredRoutes(id: string, o: { persist: boolean }): Promise<void>;
      }
    ).reassertConfiguredRoutes("ir1", { persist: false });

    expect(exit.users.has("route:route-fr")).toBe(false);
  });

  it("marks the route asserted only once the exit node acks", async () => {
    const { sweep, drainAcks, stored } = build();

    await sweep();
    // The write went out, but nothing has confirmed it yet.
    expect(stored.uplinkAssertedAt).toBeUndefined();

    await drainAcks();
    expect(stored.uplinkAssertedAt).toBeInstanceOf(Date);
    expect(stored.uplinkLastError).toBeNull();
  });

  it("records a rejection instead of discarding it", async () => {
    const { service, stored } = build();

    await (
      service as unknown as {
        handleCommandAck(a: { commandId: string; success: boolean; error: string }): Promise<void>;
      }
    ).handleCommandAck({
      commandId: `${UPLINK_ACK_PREFIX}route-fr`,
      success: false,
      error: "xray AlterInbound (add user route:route-fr): inbound not found",
    });

    expect(stored.uplinkLastError).toContain("inbound not found");
    expect(stored.uplinkAssertedAt).toBeUndefined();
  });

  it("does not claim an uplink is asserted when the exit node is offline", async () => {
    // The panel showing green over a dead route is the failure being
    // fixed; an unreachable exit must read as unhealthy, not as
    // unchanged.
    const { sweep, stored } = build({ exitConnected: false });

    await sweep();

    expect(stored.uplinkAssertedAt).toBeUndefined();
    expect(stored.uplinkLastError).toContain("not connected");
  });

  it("sends the exit's own inbound tag when it has one", async () => {
    // An exit running two inbounds of one protocol would otherwise take
    // the uplink onto its default listener while the relay dials the
    // other -- a credential that exists and still cannot authenticate.
    const exitPayloads: { inboundTag?: string }[] = [];
    const { service, prisma } = build();
    (
      prisma.route.findMany as jest.Mock
    ).mockResolvedValue([
      {
        id: "route-fr",
        uplinkCredentialsJson: JSON.stringify({ uuid: "u" }),
        entryProtocolConfig: {
          nodeId: "ir1",
          protocol: "XRAY_VLESS_REALITY",
          inboundTag: "vless-fr-in",
          listenPort: 8444,
          transport: "TCP",
          publicParamsJson: {},
        },
        exitProtocolConfig: {
          nodeId: "france-1",
          protocol: "XRAY_VLESS_REALITY",
          transport: "TCP",
          inboundTag: "vless-second-in",
          listenPort: 2087,
          publicParamsJson: {},
          node: { id: "france-1", publicIp: "104.105.205.233" },
        },
      },
    ]);
    (service as unknown as Record<string, unknown>).writeCommand = (
      nodeId: string,
      _id: string,
      type: string,
      payload: { inboundTag?: string },
    ) => {
      if (nodeId === "france-1" && type === "CREATE_USER") exitPayloads.push(payload);
      return true;
    };

    await (
      service as unknown as {
        reassertConfiguredRoutes(id: string, o: { persist: boolean }): Promise<void>;
      }
    ).reassertConfiguredRoutes("ir1", { persist: false });

    expect(exitPayloads).toHaveLength(1);
    expect(exitPayloads[0].inboundTag).toBe("vless-second-in");
  });
});
