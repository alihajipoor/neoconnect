import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { AgentGatewayService } from "./agent-gateway.service";

/** A DestinationBatch is stored like a StatsBatch: only from a stream
 * that has said, and proved, which node it is, and under that node.
 * The node id is what makes a credential id in the batch mean one
 * customer, so a batch with no node behind it must write nothing. */
describe("AgentGatewayService destinationBatch", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32);

  function hello(nodeId = "node-1") {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "n1";
    const signature = sign(null, Buffer.from(`${nodeId}.${timestamp}.${nonce}`, "utf8"), privateKey);
    return { payload: "hello", hello: { nodeId, timestamp, nonce, signature, agentVersion: "v0.2.11" } };
  }

  const batch = {
    windowStart: "1793000000",
    windowEnd: "1793000060",
    destinations: [
      {
        externalUserId: "user-a",
        inboundTag: "vless-in",
        network: "tcp",
        host: "203.0.113.7",
        port: 443,
        count: 2,
        firstSeen: "1793000001",
        lastSeen: "1793000050",
      },
    ],
    dropped: 0,
  };

  class FakeCall extends EventEmitter {
    destroyed: Error | null = null;
    write = jest.fn();
    end = jest.fn();
    destroy(err: Error) {
      this.destroyed ??= err;
    }
  }

  function build() {
    const prisma = {
      node: {
        findUnique: jest.fn().mockResolvedValue({ id: "node-1", name: "test-node", agentPubKey: rawPublic.toString("base64") }),
      },
    };
    const nodesService = { setStatus: jest.fn().mockResolvedValue(undefined), touchHeartbeat: jest.fn() };
    const registry = { set: jest.fn(), delete: jest.fn(), get: jest.fn() };
    const siteVisits = { record: jest.fn().mockResolvedValue(1) };
    const service = new AgentGatewayService(
      prisma as never,
      nodesService as never,
      registry as never,
      {} as never,
      { recordDeltas: jest.fn() } as never,
      { handleReport: jest.fn() } as never,
      siteVisits as never,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(service as never, "syncAfterHello").mockImplementation((() => Promise.resolve()) as never);
    const call = new FakeCall();
    (service as unknown as { handleAgentSync(c: unknown): void }).handleAgentSync(call);
    const settle = async () => {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    const send = async (msg: object) => {
      call.emit("data", msg);
      await settle();
    };
    return { call, send, settle, siteVisits, prisma };
  }

  /** Holds the node lookup of the next Hello open until `answer` is
   * called, so a test can send while the Hello is still being checked. */
  function holdHelloCheck(prisma: ReturnType<typeof build>["prisma"]) {
    let answer!: (node: unknown) => void;
    prisma.node.findUnique.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    return (node: unknown) => answer(node);
  }

  it("closes a stream that sends one before any Hello, and stores nothing", async () => {
    const { call, send, siteVisits } = build();

    await send({ payload: "destinationBatch", destinationBatch: batch });

    expect(call.destroyed?.message).toMatch(/destinationBatch received before a valid Hello/);
    expect(siteVisits.record).not.toHaveBeenCalled();
  });

  it("stores one under the node the stream authenticated as", async () => {
    const { call, send, siteVisits } = build();

    await send(hello());
    await send({ payload: "destinationBatch", destinationBatch: batch });

    expect(call.destroyed).toBeNull();
    expect(siteVisits.record).toHaveBeenCalledWith("node-1", batch);
  });

  // The agent sends what it queued during an outage the moment its Hello
  // is written, so these batches land while the backend is still looking
  // the node up. They used to be dropped there, silently: the agent's send
  // had succeeded, so it never counted them as lost.
  it("keeps the batches an agent sends while its Hello is still being checked", async () => {
    const { call, send, settle, siteVisits, prisma } = build();
    const answer = holdHelloCheck(prisma);
    const queued = [batch, { ...batch, windowStart: "1793000060", windowEnd: "1793000120" }];

    call.emit("data", hello());
    for (const b of queued) call.emit("data", { payload: "destinationBatch", destinationBatch: b });
    await settle();
    expect(siteVisits.record).not.toHaveBeenCalled();
    expect(call.destroyed).toBeNull();

    answer({ id: "node-1", name: "test-node", agentPubKey: rawPublic.toString("base64") });
    await settle();

    expect(call.destroyed).toBeNull();
    expect(siteVisits.record.mock.calls).toEqual([
      ["node-1", queued[0]],
      ["node-1", queued[1]],
    ]);

    // And once the Hello is done, a batch is stored as it arrives.
    await send({ payload: "destinationBatch", destinationBatch: batch });
    expect(siteVisits.record).toHaveBeenCalledTimes(3);
  });

  it("stores nothing that waited on a Hello which then failed", async () => {
    const { call, settle, siteVisits, prisma } = build();
    const answer = holdHelloCheck(prisma);

    call.emit("data", hello("node-unknown"));
    call.emit("data", { payload: "destinationBatch", destinationBatch: batch });
    answer(null);
    await settle();

    expect(call.destroyed?.message).toMatch(/unknown or unclaimed node/);
    expect(siteVisits.record).not.toHaveBeenCalled();
  });
});
