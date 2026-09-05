import { AgentGatewayService } from "./agent-gateway.service";

/** A dropped stream is not an outage.
 *
 * turkey-1 sits on a link that resets the gRPC stream every few minutes
 * and re-dials within a second. Marking it OFFLINE on close produced
 * three Discord alerts per blip -- "went OFFLINE", "STILL OFFLINE -- no
 * heartbeat for 0h", "back ONLINE" -- for a node that never missed a
 * heartbeat deadline. Liveness belongs to the sweep and its threshold.
 */
describe("AgentGatewayService stream close", () => {
  function build() {
    const registry = { delete: jest.fn(), get: jest.fn(), connectedNodeIds: () => [] };
    const nodesService = { setStatus: jest.fn(), suppressNextOfflineReminder: jest.fn(), remindAboutOfflineNodes: jest.fn() };
    const prisma = { node: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new AgentGatewayService(
      prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    (service as unknown as { registry: unknown }).registry = registry;
    (service as unknown as { nodesService: unknown }).nodesService = nodesService;
    return { service, registry, nodesService, prisma };
  }

  const close = (s: AgentGatewayService, id: string, call: unknown) =>
    (s as unknown as { handleStreamClosed(i: string, c: unknown): void }).handleStreamClosed(id, call);
  const sweep = (s: AgentGatewayService) =>
    (s as unknown as { sweepStaleNodes(): Promise<void> }).sweepStaleNodes();

  it("drops the routing entry so a closed call is never handed work", () => {
    const { service, registry } = build();
    const call = {};
    close(service, "node-1", call);
    expect(registry.delete).toHaveBeenCalledWith("node-1", call);
  });

  it("does not mark the node OFFLINE -- a one-second reconnect is not an outage", () => {
    const { service, nodesService } = build();
    close(service, "node-1", {});
    expect(nodesService.setStatus).not.toHaveBeenCalled();
  });

  it("still reports a node whose heartbeat actually went stale", async () => {
    const { service, nodesService, prisma } = build();
    prisma.node.findMany.mockResolvedValue([{ id: "node-1", name: "turkey-1" }]);
    await sweep(service);
    expect(nodesService.setStatus).toHaveBeenCalledWith("node-1", "OFFLINE");
    // And holds the repeat back, so the transition alert does not arrive
    // paired with a "STILL OFFLINE -- no heartbeat for 0h".
    expect(nodesService.suppressNextOfflineReminder).toHaveBeenCalledWith("node-1");
  });
});
