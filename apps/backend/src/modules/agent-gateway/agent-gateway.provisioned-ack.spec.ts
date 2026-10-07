import { cursoredFindMany } from "../../../test/cursored";
import { AgentGatewayService, CONFIRM_ACK_PREFIX } from "./agent-gateway.service";
import { encryptCredentials } from "../protocol-users/credentials-crypto";

/** A node's ack is what tells the control plane a credential exists on
 * it, and what lets a device's own credential replace the shared one in
 * what the device is handed (ProtocolUsersService.deviceView). These pin
 * which acks record that and which do not. */
describe("AgentGatewayService records which credentials a node has confirmed", () => {
  type Ack = { commandId: string; success: boolean; error: string };

  function build(opts: { command?: { nodeId: string; type: string; payloadJson: unknown } | null; rows?: unknown[] } = {}) {
    const prisma = {
      agentCommand: {
        findFirst: jest.fn().mockResolvedValue(opts.command ?? null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      protocolUser: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: cursoredFindMany((opts.rows ?? []) as { id: string }[]),
      },
    };
    const call = { write: jest.fn() };
    const registry = { get: jest.fn().mockReturnValue(call) };
    const service = new AgentGatewayService(
      prisma as never,
      {} as never,
      registry as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const ack = (a: Ack, from = "node-1") =>
      (service as unknown as { handleCommandAck(n: string, a: Ack): Promise<void> }).handleCommandAck(from, a);
    const reassert = () =>
      (
        service as unknown as { reassertProvisionedUsers(id: string, o: { persist: boolean }): Promise<void> }
      ).reassertProvisionedUsers("node-1", { persist: false });
    return { service, prisma, call, ack, reassert };
  }

  it("marks the credential a stored CREATE_USER named once the node carries it out", async () => {
    const { prisma, ack } = build({
      command: { nodeId: "node-1", type: "CREATE_USER", payloadJson: { externalUserId: "ext-1", protocol: "WIREGUARD" } },
    });

    await ack({ commandId: "cmd-1", success: true, error: "" });

    expect(prisma.protocolUser.updateMany).toHaveBeenCalledWith({
      where: { nodeId: "node-1", externalUserId: "ext-1", provisionedAt: null },
      data: { provisionedAt: expect.any(Date) },
    });
    expect(prisma.agentCommand.updateMany).toHaveBeenCalled();
  });

  it("marks nothing when the node reports the command failed", async () => {
    const { prisma, ack } = build({
      command: { nodeId: "node-1", type: "CREATE_USER", payloadJson: { externalUserId: "ext-1" } },
    });

    await ack({ commandId: "cmd-1", success: false, error: "inbound not found" });

    expect(prisma.protocolUser.updateMany).not.toHaveBeenCalled();
  });

  it("marks nothing for a command that does not add a user", async () => {
    const { prisma, ack } = build({
      command: { nodeId: "node-1", type: "DELETE_USER", payloadJson: { externalUserId: "ext-1" } },
    });

    await ack({ commandId: "cmd-1", success: true, error: "" });

    expect(prisma.protocolUser.updateMany).not.toHaveBeenCalled();
  });

  it("re-asserts an unconfirmed credential under the confirming prefix, and records its ack", async () => {
    const { call, ack, prisma, reassert } = build({
      rows: [
        {
          id: "pu-new",
          nodeId: "node-1",
          protocol: "XRAY_VLESS_REALITY",
          externalUserId: "ext-new",
          status: "ACTIVE",
          provisionedAt: null,
          credentialsJson: encryptCredentials({ uuid: "ext-new" }),
          protocolConfig: { transport: "TCP", inboundTag: null },
        },
        {
          id: "pu-old",
          nodeId: "node-1",
          protocol: "XRAY_VLESS_REALITY",
          externalUserId: "ext-old",
          status: "ACTIVE",
          provisionedAt: new Date(),
          credentialsJson: encryptCredentials({ uuid: "ext-old" }),
          protocolConfig: { transport: "TCP", inboundTag: null },
        },
      ],
    });

    await reassert();

    const ids = call.write.mock.calls.map((c) => (c[0] as { command: { id: string } }).command.id);
    expect(ids.sort()).toEqual([`${CONFIRM_ACK_PREFIX}pu-new`, "reassert:pu-old"]);

    await ack({ commandId: `${CONFIRM_ACK_PREFIX}pu-new`, success: true, error: "" });
    expect(prisma.protocolUser.updateMany).toHaveBeenCalledWith({
      where: { id: "pu-new", nodeId: "node-1", provisionedAt: null },
      data: { provisionedAt: expect.any(Date) },
    });
  });

  /** protocol_users keeps credentials encrypted; agent_commands kept the
   * same credentials in the clear, forever. Once a command is acked or
   * failed nothing replays it, so the secret goes. */
  it.each([
    ["acked", true],
    ["failed", false],
  ])("removes the credentials from a command once it is %s, and keeps the rest", async (_label, success) => {
    const { prisma, ack } = build({
      command: {
        nodeId: "node-1",
        type: "CREATE_USER",
        payloadJson: { protocol: "WIREGUARD", externalUserId: "ext-1", credentials: { privateKey: "secret" } },
      },
    });

    await ack({ commandId: "cmd-1", success, error: success ? "" : "boom" });

    expect(prisma.agentCommand.updateMany).toHaveBeenCalledWith({
      where: { id: "cmd-1", nodeId: "node-1" },
      data: expect.objectContaining({ payloadJson: { protocol: "WIREGUARD", externalUserId: "ext-1" } }),
    });
  });

  it("leaves a payload with no credentials untouched", async () => {
    const { prisma, ack } = build({
      command: { nodeId: "node-1", type: "DELETE_USER", payloadJson: { protocol: "XRAY_TROJAN", externalUserId: "ext-1" } },
    });

    await ack({ commandId: "cmd-1", success: true, error: "" });

    expect(prisma.agentCommand.updateMany.mock.calls[0][0].data).not.toHaveProperty("payloadJson");
  });

  // One ack per user per minute: the confirmed majority must cost nothing.
  it("touches the database not at all for the ack of an already-confirmed re-assert", async () => {
    const { prisma, ack } = build();

    await ack({ commandId: "reassert:pu-old", success: true, error: "" });

    expect(prisma.protocolUser.updateMany).not.toHaveBeenCalled();
    expect(prisma.agentCommand.updateMany).not.toHaveBeenCalled();
    expect(prisma.agentCommand.findFirst).not.toHaveBeenCalled();
  });

  /** An ack used to update whatever its id named, whichever stream it came
   * in on: one node could mark another's queued DELETE_USER acked, and it
   * would never be replayed. */
  it("looks a stored command up on the acking node only, and records nothing for another node's", async () => {
    const { prisma, ack } = build({ command: null });

    await ack({ commandId: "cmd-of-node-2", success: true, error: "" }, "node-1");

    expect(prisma.agentCommand.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cmd-of-node-2", nodeId: "node-1" } }),
    );
    expect(prisma.agentCommand.updateMany).not.toHaveBeenCalled();
    expect(prisma.protocolUser.updateMany).not.toHaveBeenCalled();
  });

  it("confirms a credential only on the node that acked it", async () => {
    const { prisma, ack } = build();

    await ack({ commandId: `${CONFIRM_ACK_PREFIX}pu-1`, success: true, error: "" }, "node-2");

    expect(prisma.protocolUser.updateMany).toHaveBeenCalledWith({
      where: { id: "pu-1", nodeId: "node-2", provisionedAt: null },
      data: { provisionedAt: expect.any(Date) },
    });
  });
});
