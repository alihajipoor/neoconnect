import { generateKeyPairSync, sign } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { AgentConnectionRegistry } from "./agent-connection-registry";
import { AgentGatewayService } from "./agent-gateway.service";
import { resolveProtoPath } from "./proto-path";
import type { AgentDuplexCall } from "./agent-messages";

/** The 2026-11-14 outage, over a real gRPC connection.
 *
 * One pool timeout on a heartbeat's database read reached the stream
 * handler's catch, which called call.destroy(err). In grpc-js that sends
 * no status and no RST_STREAM: the HTTP/2 stream stayed open on a healthy
 * connection, the server stopped reading it, and seven agents sat in
 * Recv() for eight minutes until the backend was restarted.
 *
 * A mock call cannot show that -- the bug is in what does and does not
 * reach the wire -- so these run grpc-js's own server and client, built
 * from the same proto and options the gateway loads. The client stands
 * in for the agent: what it observes (a status code on the stream, or
 * further messages) is what grpc-go's Recv() returns to the real one.
 * Each test fails on the code before the fix by timing out. */
describe("AgentGatewayService stream failures over real gRPC", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const poolTimeout = () =>
    Object.assign(
      new Error(
        "Timed out fetching a new connection from the connection pool. (Current connection pool timeout: 10, connection limit: 5)",
      ),
      { code: "P2024" },
    );

  const definition = protoLoader.loadSync(resolveProtoPath(), { longs: String, enums: String, defaults: true, oneofs: true });
  const proto = grpc.loadPackageDefinition(definition) as unknown as {
    neoxify: { agent: { v1: { AgentGateway: grpc.ServiceClientConstructor & { service: grpc.ServiceDefinition } } } };
  };
  const Gateway = proto.neoxify.agent.v1.AgentGateway;

  let server: grpc.Server;
  let client: grpc.Client & { agentSync(): grpc.ClientDuplexStream<object, Record<string, unknown>> };
  let service: AgentGatewayService;
  let registry: AgentConnectionRegistry;
  let prisma: { node: { findUnique: jest.Mock; findMany: jest.Mock } };
  let nodesService: Record<string, jest.Mock>;

  beforeEach(async () => {
    prisma = {
      node: {
        findUnique: jest.fn().mockResolvedValue({ id: "node-1", name: "test-node", agentPubKey: rawPublic.toString("base64") }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    nodesService = {
      setStatus: jest.fn().mockResolvedValue(undefined),
      touchHeartbeat: jest.fn().mockResolvedValue(undefined),
      recordRealityDestHealth: jest.fn().mockResolvedValue(undefined),
      suppressNextOfflineReminder: jest.fn(),
      remindAboutOfflineNodes: jest.fn().mockResolvedValue(undefined),
      pageHeartbeatGaps: jest.fn().mockResolvedValue(undefined),
    };
    registry = new AgentConnectionRegistry();
    service = new AgentGatewayService(
      prisma as never,
      nodesService as never,
      registry,
      {} as never,
      { recordDeltas: jest.fn().mockResolvedValue(undefined) } as never,
      { handleReport: jest.fn().mockResolvedValue(undefined) } as never,
      { observe: jest.fn().mockResolvedValue(undefined) } as never,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(service as never, "syncAfterHello").mockResolvedValue(undefined as never);

    // The gateway's own keepalive options (onModuleInit).
    server = new grpc.Server({
      "grpc.keepalive_time_ms": 20_000,
      "grpc.keepalive_timeout_ms": 10_000,
      "grpc.keepalive_permit_without_calls": 1,
      "grpc.http2.min_ping_interval_without_data_ms": 20_000,
      "grpc.http2.max_pings_without_data": 0,
    });
    server.addService(Gateway.service, {
      agentSync: (call: AgentDuplexCall) => (service as unknown as { handleAgentSync(c: AgentDuplexCall): void }).handleAgentSync(call),
    });
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
    );
    client = new Gateway(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as never;
  });

  afterEach(() => {
    client.close();
    server.forceShutdown();
  });

  function hello(nodeId = "node-1") {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "n1";
    const signature = sign(null, Buffer.from(`${nodeId}.${timestamp}.${nonce}`, "utf8"), privateKey);
    return { hello: { nodeId, timestamp, nonce, signature, agentVersion: "v0.2.12" } };
  }

  /** Opens a stream as an agent does and records what it receives. */
  function agent() {
    const stream = client.agentSync();
    const received: Record<string, unknown>[] = [];
    const status = new Promise<grpc.ServiceError>((resolve) => stream.on("error", resolve));
    stream.on("data", (m) => received.push(m));
    return { stream, received, status };
  }

  const within = <T>(p: Promise<T>, ms: number, what: string) =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms))]);
  const until = async (cond: () => boolean, ms: number, what: string) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("keeps the stream when a heartbeat's database read is rejected (the incident's trigger)", async () => {
    nodesService.recordRealityDestHealth.mockRejectedValue(poolTimeout());
    const a = agent();
    a.stream.write(hello());
    await until(() => registry.isConnected("node-1"), 2000, "registered");

    a.stream.write({ heartbeat: { realityDest: "example.org:443", realityDestReachable: true } });
    await until(() => nodesService.recordRealityDestHealth.mock.calls.length === 1, 2000, "dest health attempted");

    // The server still writes to this agent...
    (service as unknown as { sendServerHeartbeats(): void }).sendServerHeartbeats();
    await until(() => a.received.some((m) => m.serverHeartbeat), 2000, "server heartbeat received");
    // ...and still reads from it.
    a.stream.write({ heartbeat: {} });
    await until(() => nodesService.touchHeartbeat.mock.calls.length === 2, 2000, "second heartbeat read");
    expect(registry.isConnected("node-1")).toBe(true);
    a.stream.cancel();
  });

  it("ends a Hello that cannot be checked with UNAVAILABLE, which the agent receives", async () => {
    prisma.node.findUnique.mockRejectedValue(poolTimeout());
    const a = agent();
    a.stream.write(hello());

    const err = await within(a.status, 3000, "status on the agent's stream");
    expect(err.code).toBe(grpc.status.UNAVAILABLE);
    expect(err.details).toMatch(/connection pool/);
  });

  it("ends a refused Hello with UNAUTHENTICATED, which the agent receives", async () => {
    prisma.node.findUnique.mockResolvedValue(null);
    const a = agent();
    a.stream.write(hello());

    const err = await within(a.status, 3000, "status on the agent's stream");
    expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
  });

  it("still tells the agent when something destroy()s its stream -- the exact shape of the outage", async () => {
    const a = agent();
    a.stream.write(hello());
    await until(() => registry.isConnected("node-1"), 2000, "registered");

    registry.get("node-1")!.destroy(poolTimeout());

    const err = await within(a.status, 3000, "status on the agent's stream");
    expect(err.code).toBe(grpc.status.UNAVAILABLE);
    expect(registry.isConnected("node-1")).toBe(false);
  });

  it("ends a stream the sweep finds silent, even when the database cannot answer", async () => {
    prisma.node.findMany.mockRejectedValue(poolTimeout());
    const a = agent();
    a.stream.write(hello());
    await until(() => registry.isConnected("node-1"), 2000, "registered");
    // Nothing from the agent for longer than the heartbeat deadline.
    for (const live of (service as unknown as { liveCalls: Map<unknown, { lastMessageAt: number }> }).liveCalls.values()) {
      live.lastMessageAt = Date.now() - 61_000;
    }

    await expect((service as unknown as { sweepStaleNodes(): Promise<void> }).sweepStaleNodes()).rejects.toThrow(/pool/);

    const err = await within(a.status, 3000, "status on the agent's stream");
    expect(err.code).toBe(grpc.status.UNAVAILABLE);
    expect(registry.isConnected("node-1")).toBe(false);
  });

  it("ends a live call for a node it marks OFFLINE, and at most once per node per interval", async () => {
    const age = () => {
      for (const live of (service as unknown as { liveCalls: Map<unknown, { lastMessageAt: number }> }).liveCalls.values()) {
        live.lastMessageAt = Date.now() - 61_000;
      }
    };
    const sweep = () => (service as unknown as { sweepStaleNodes(): Promise<void> }).sweepStaleNodes();
    prisma.node.findMany.mockResolvedValue([{ id: "node-1", name: "test-node" }]);
    const first = agent();
    first.stream.write(hello());
    await until(() => registry.isConnected("node-1"), 2000, "registered");
    age();

    await sweep();

    expect((await within(first.status, 3000, "status on the first stream")).code).toBe(grpc.status.UNAVAILABLE);
    expect(nodesService.setStatus).toHaveBeenCalledWith("node-1", "OFFLINE");

    // The agent redials at once and that stream, too, goes quiet. A
    // sweep inside the same interval leaves it alone: no storm.
    const second = agent();
    second.stream.write(hello());
    await until(() => registry.isConnected("node-1"), 2000, "re-registered");
    age();
    await sweep();
    let ended = false;
    void second.status.then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(ended).toBe(false);
    second.stream.cancel();
  });

  it("never drops a node that is heartbeating, even when the database says its heartbeat is stale", async () => {
    nodesService.touchHeartbeat.mockRejectedValueOnce(poolTimeout());
    const a = agent();
    a.stream.write(hello());
    await until(() => registry.isConnected("node-1"), 2000, "registered");
    a.stream.write({ heartbeat: {} });
    await until(() => nodesService.touchHeartbeat.mock.calls.length === 1, 2000, "heartbeat read");
    // Its write failed, so the database has it stale.
    prisma.node.findMany.mockResolvedValue([{ id: "node-1", name: "test-node" }]);

    await (service as unknown as { sweepStaleNodes(): Promise<void> }).sweepStaleNodes();

    expect(nodesService.setStatus).not.toHaveBeenCalledWith("node-1", "OFFLINE");
    expect(nodesService.touchHeartbeat).toHaveBeenCalledTimes(2); // the sweep's retry
    expect(registry.isConnected("node-1")).toBe(true);
    a.stream.cancel();
  });

  it("ends a node's old silent stream and leaves its new, talking one alone", async () => {
    const old = agent();
    old.stream.write(hello());
    await until(() => registry.isConnected("node-1"), 2000, "registered");
    const [oldLive] = (service as unknown as { liveCalls: Map<unknown, { lastMessageAt: number }> }).liveCalls.values();
    const fresh = agent();
    fresh.stream.write(hello());
    await until(() => nodesService.setStatus.mock.calls.length === 2, 2000, "second Hello");
    oldLive.lastMessageAt = Date.now() - 61_000;

    await (service as unknown as { sweepStaleNodes(): Promise<void> }).sweepStaleNodes();

    expect((await within(old.status, 3000, "status on the old stream")).code).toBe(grpc.status.UNAVAILABLE);
    expect(registry.isConnected("node-1")).toBe(true);
    let ended = false;
    void fresh.status.then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 200));
    expect(ended).toBe(false);
    fresh.stream.cancel();
  });

  it("never lets an old stream's slow Hello overwrite the node's newer, registered stream", async () => {
    // The first Hello's status write is held: the old call sits on a slow
    // database (or a half-open link) while the agent redials.
    let releaseOld!: () => void;
    nodesService.setStatus.mockImplementationOnce(() => new Promise<void>((r) => (releaseOld = r)));
    const old = agent();
    old.stream.write(hello());
    await until(() => nodesService.setStatus.mock.calls.length === 1, 2000, "old Hello at its status write");
    const fresh = agent();
    fresh.stream.write(hello());
    await until(() => registry.isConnected("node-1"), 2000, "fresh stream registered");
    const freshCall = registry.get("node-1");

    releaseOld();

    expect((await within(old.status, 3000, "status on the old stream")).code).toBe(grpc.status.UNAVAILABLE);
    expect(registry.get("node-1")).toBe(freshCall);
    // The talking stream still gets the control plane's writes.
    (service as unknown as { sendServerHeartbeats(): void }).sendServerHeartbeats();
    await until(() => fresh.received.some((m) => m.serverHeartbeat), 2000, "server heartbeat on the fresh stream");
    fresh.stream.cancel();
  });

  it("keeps the in-flight re-asserts of a node's newer stream when an old one closes", async () => {
    const reasserts = (service as unknown as { unackedReasserts: Map<string, { nodeId: string; at: number }> }).unackedReasserts;
    const old = agent();
    old.stream.write(hello());
    await until(() => registry.isConnected("node-1"), 2000, "registered");
    const fresh = agent();
    fresh.stream.write(hello());
    await until(() => nodesService.setStatus.mock.calls.length === 2, 2000, "second Hello");
    await until(() => (service as unknown as { liveCalls: Map<unknown, { nodeId: string | null }> }).liveCalls.size === 2, 2000, "two calls");
    reasserts.set("cmd-on-fresh", { nodeId: "node-1", at: Date.now() });

    old.stream.cancel();
    await until(() => (service as unknown as { liveCalls: Map<unknown, unknown> }).liveCalls.size === 1, 2000, "old call gone");

    expect(reasserts.has("cmd-on-fresh")).toBe(true);
    // With no newer stream, a close still clears the node's entries.
    fresh.stream.cancel();
    await until(() => !registry.isConnected("node-1"), 2000, "unregistered");
    expect(reasserts.has("cmd-on-fresh")).toBe(false);
  });

  it("does not end an anonymous call after 30 s while its Hello is still being checked", async () => {
    const liveCalls = () =>
      [...(service as unknown as { liveCalls: Map<unknown, { openedAt: number }> }).liveCalls.values()];
    const endSilent = () => (service as unknown as { endSilentCalls(n: number): void }).endSilentCalls(Date.now());
    let releaseCheck!: (v: unknown) => void;
    prisma.node.findUnique.mockImplementationOnce(() => new Promise((r) => (releaseCheck = r)));
    const checking = agent();
    checking.stream.write(hello());
    await until(() => prisma.node.findUnique.mock.calls.length === 1, 2000, "Hello being checked");
    expect(liveCalls()).toHaveLength(1);

    for (const live of liveCalls()) live.openedAt = Date.now() - 31_000;
    endSilent();

    let ended = false;
    void checking.status.then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(ended).toBe(false);
    releaseCheck({ id: "node-1", name: "test-node", agentPubKey: rawPublic.toString("base64") });
    await until(() => registry.isConnected("node-1"), 2000, "registered once checked");
    checking.stream.cancel();
  });

  it("ends an anonymous call that has sent nothing for 30 s", async () => {
    const a = agent();
    // A call opens on the first write; an empty-payload message is the
    // nearest thing to an agent that never says who it is.
    a.stream.write({});
    const liveCalls = (service as unknown as { liveCalls: Map<unknown, { openedAt: number }> }).liveCalls;
    await until(() => liveCalls.size === 1, 2000, "call accepted");
    for (const live of liveCalls.values()) live.openedAt = Date.now() - 31_000;

    (service as unknown as { endSilentCalls(n: number): void }).endSilentCalls(Date.now());

    expect((await within(a.status, 3000, "status on the anonymous stream")).code).toBe(grpc.status.UNAUTHENTICATED);
  });

  it("takes a cancelled stream out of the registry", async () => {
    const a = agent();
    a.stream.write(hello());
    await until(() => registry.isConnected("node-1"), 2000, "registered");
    a.stream.cancel();
    await until(() => !registry.isConnected("node-1"), 2000, "unregistered on cancel");
  });
});
