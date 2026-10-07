import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { AgentGatewayService, UPLINK_ACK_PREFIX } from "./agent-gateway.service";

/** What a stream may do before, during and after its Hello.
 *
 * Two findings of the 2026-10-06 review. The node id used to be known to
 * the stream only once the whole Hello had been handled -- the outbox
 * replay and a re-assert of every credential and route -- so a heartbeat
 * arriving during a long one closed an authenticated stream. And a
 * commandAck was handled with no Hello at all, from anyone who could
 * reach the port, and was not tied to any node. */
describe("AgentGatewayService stream authentication", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32);

  function hello(nodeId = "node-1") {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "n1";
    const signature = sign(null, Buffer.from(`${nodeId}.${timestamp}.${nonce}`, "utf8"), privateKey);
    return { payload: "hello", hello: { nodeId, timestamp, nonce, signature, agentVersion: "v0.2.9" } };
  }

  class FakeCall extends EventEmitter {
    destroyed: Error | null = null;
    write = jest.fn();
    end = jest.fn();
    destroy(err: Error) {
      this.destroyed ??= err;
    }
  }

  function build() {
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => (releaseSync = resolve));
    const prisma = {
      node: {
        findUnique: jest.fn().mockResolvedValue({ id: "node-1", name: "test-node", agentPubKey: rawPublic.toString("base64") }),
      },
      route: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      protocolUser: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      agentCommand: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
    };
    const nodesService = {
      setStatus: jest.fn().mockResolvedValue(undefined),
      touchHeartbeat: jest.fn().mockResolvedValue(undefined),
      recordRealityDestHealth: jest.fn(),
    };
    const registry = { set: jest.fn(), delete: jest.fn(), get: jest.fn() };
    const service = new AgentGatewayService(
      prisma as never,
      nodesService as never,
      registry as never,
      {} as never,
      { recordDeltas: jest.fn().mockResolvedValue(undefined) } as never,
      { handleReport: jest.fn().mockResolvedValue(undefined) } as never,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    // The slow part of a Hello -- outbox replay, re-assert of every
    // credential and route -- held open until the test lets it finish.
    const sync = jest.spyOn(service as never, "syncAfterHello").mockImplementation((() => syncGate) as never);
    const call = new FakeCall();
    (service as unknown as { handleAgentSync(c: unknown): void }).handleAgentSync(call);
    const send = async (msg: object) => {
      call.emit("data", msg);
      // Let the handler's awaits run.
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    return { call, send, prisma, nodesService, registry, releaseSync, sync };
  }

  it("handles a heartbeat that arrives while the Hello is still replaying, instead of closing the stream", async () => {
    const { call, send, nodesService, releaseSync } = build();

    await send(hello());
    await send({ payload: "heartbeat", heartbeat: {} });

    expect(call.destroyed).toBeNull();
    expect(nodesService.touchHeartbeat).toHaveBeenCalledWith("node-1");
    releaseSync();
  });

  it("unregisters a stream that closes mid-Hello, so nothing is written to it", async () => {
    const { call, send, registry, releaseSync } = build();

    await send(hello());
    call.emit("error", new Error("reset"));

    expect(registry.delete).toHaveBeenCalledWith("node-1", call);
    releaseSync();
  });

  it("closes a stream that sends a commandAck before any Hello, and writes nothing", async () => {
    const { call, send, prisma } = build();

    await send({ payload: "commandAck", commandAck: { commandId: `${UPLINK_ACK_PREFIX}route-1`, success: true, error: "" } });

    expect(call.destroyed?.message).toMatch(/before a valid Hello/);
    expect(prisma.route.updateMany).not.toHaveBeenCalled();
    expect(prisma.protocolUser.updateMany).not.toHaveBeenCalled();
  });

  it("records an uplink ack only against a route whose exit is the acking node", async () => {
    const { send, prisma, releaseSync } = build();

    await send(hello());
    await send({ payload: "commandAck", commandAck: { commandId: `${UPLINK_ACK_PREFIX}route-1`, success: true, error: "" } });

    expect(prisma.route.updateMany).toHaveBeenCalledWith({
      where: { id: "route-1", exitProtocolConfig: { is: { nodeId: "node-1" } } },
      data: { uplinkAssertedAt: expect.any(Date), uplinkLastError: null },
    });
    releaseSync();
  });

  it("closes a stream whose Hello is not signed by the node's key", async () => {
    const { call, send, registry } = build();
    const forged = hello();
    forged.hello.signature = Buffer.alloc(64);

    await send(forged);

    expect(call.destroyed?.message).toMatch(/invalid Hello signature/);
    expect(registry.set).not.toHaveBeenCalled();
  });
});
