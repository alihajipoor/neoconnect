import { AgentGatewayService } from "./agent-gateway.service";
import { encryptCredentials } from "../protocol-users/credentials-crypto";

/** The reconnect path is the only thing standing between a node reboot
 * and every customer on that node silently losing service, so what it
 * sends is pinned down here rather than left to inspection.
 *
 * Reaches the private method deliberately: driving it through a real
 * gRPC Hello would need a signed handshake and a live stream, which
 * tests the transport rather than the reconciliation this exists for. */
describe("AgentGatewayService reconnect reconciliation", () => {
  function build(users: { protocol: string; externalUserId: string; credentials: Record<string, string> }[]) {
    const prisma = {
      protocolUser: {
        findMany: jest.fn().mockResolvedValue(
          users.map((u, i) => ({
            id: `pu-${i}`,
            nodeId: "node-1",
            protocol: u.protocol,
            externalUserId: u.externalUserId,
            status: "ACTIVE",
            credentialsJson: encryptCredentials(u.credentials),
          })),
        ),
      },
    };

    const service = new AgentGatewayService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const enqueue = jest.spyOn(service, "enqueueCommand").mockResolvedValue({} as never);
    return { service, prisma, enqueue };
  }

  /** Invokes the private reconciliation the same way handleHello does. */
  function reassert(service: AgentGatewayService, nodeId: string): Promise<void> {
    return (service as unknown as { reassertProvisionedUsers(id: string): Promise<void> }).reassertProvisionedUsers(
      nodeId,
    );
  }

  it("re-creates every active user when an agent reconnects", async () => {
    // The reboot case: the engines came up empty, and nothing else in
    // the system would notice.
    const { service, enqueue } = build([
      { protocol: "WIREGUARD", externalUserId: "peer-key-1", credentials: { privateKey: "a", address: "10.66.0.2/32" } },
      { protocol: "XRAY_VLESS_REALITY", externalUserId: "uuid-2", credentials: { uuid: "uuid-2", flow: "vision" } },
    ]);

    await reassert(service, "node-1");

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith("node-1", "CREATE_USER", {
      protocol: "WIREGUARD",
      externalUserId: "peer-key-1",
      credentials: { privateKey: "a", address: "10.66.0.2/32" },
    });
  });

  it("sends decrypted credentials, since the agent cannot use the stored form", async () => {
    const { service, enqueue } = build([
      { protocol: "XRAY_VLESS_REALITY", externalUserId: "uuid-1", credentials: { uuid: "uuid-1", flow: "vision" } },
    ]);

    await reassert(service, "node-1");

    const payload = enqueue.mock.calls[0][2] as { credentials: Record<string, string> };
    expect(payload.credentials).toEqual({ uuid: "uuid-1", flow: "vision" });
  });

  it("only reasserts users belonging to the node that reconnected", async () => {
    const { service, prisma } = build([]);

    await reassert(service, "node-1");

    expect(prisma.protocolUser.findMany).toHaveBeenCalledWith({
      where: { nodeId: "node-1", status: "ACTIVE" },
    });
  });

  it("sends nothing for a node with no provisioned users", async () => {
    const { service, enqueue } = build([]);

    await reassert(service, "node-1");

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("skips users that are disabled rather than restoring their access", async () => {
    // Suspended and over-quota customers are DISABLED, not deleted. A
    // blanket re-create would hand them back working credentials as a
    // side effect of an unrelated reboot.
    const { service, prisma } = build([]);

    await reassert(service, "node-1");

    const where = prisma.protocolUser.findMany.mock.calls[0][0].where as { status: string };
    expect(where.status).toBe("ACTIVE");
  });
});
