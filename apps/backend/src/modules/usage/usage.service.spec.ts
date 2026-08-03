import { UsageService } from "./usage.service";

/** How an agent-reported delta finds the row it belongs to.
 *
 * A node runs several inbounds in one Xray process, and Xray keeps usage
 * per user rather than per inbound -- so the agent reports every Xray
 * user under whichever Xray protocol is doing the reporting, which is
 * not necessarily the one that user connects with. Matching on that
 * label dropped those deltas silently, and the customers behind them
 * used the service without ever accruing against their cap.
 */
describe("UsageService.recordDeltas protocol-user lookup", () => {
  function build(protocolUser: Record<string, unknown> | null) {
    const prisma = {
      protocolUser: { findFirst: jest.fn().mockResolvedValue(protocolUser) },
      usageRecord: { findFirst: jest.fn().mockResolvedValue(null) },
      // Returns the callback's own promise rather than awaiting it: the
      // real $transaction resolves to whatever the callback does.
      $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          usageRecord: { create: jest.fn() },
          subscription: {
            update: jest.fn().mockResolvedValue({
              id: "sub-1",
              status: "ACTIVE",
              dataUsedBytes: 1n,
              dataCapBytes: 1_000_000n,
            }),
          },
        }),
      ),
    };
    const service = new UsageService(prisma as never, {} as never, {} as never);
    return { service, prisma };
  }

  const user = { id: "pu-1", subscriptionId: "sub-1", createdAt: new Date(), protocol: "XRAY_TROJAN" };

  it("finds the user by external id, whatever protocol the node reported", async () => {
    const { service, prisma } = build(user);

    // A Trojan customer's traffic, reported under the protocol of the
    // inbound that happened to drain Xray's counters that poll.
    await service.recordDeltas("node-1", [
      { externalUserId: "ext-1", protocol: "XRAY_VLESS_REALITY", bytesUp: "10", bytesDown: "20" },
    ]);

    const { where } = prisma.protocolUser.findFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(where).toEqual({ nodeId: "node-1", externalUserId: "ext-1" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("still records nothing when no user owns that external id", async () => {
    // A relay's shared uplink identity has no ProtocolUser by design.
    const { service, prisma } = build(null);

    await service.recordDeltas("node-1", [
      { externalUserId: "route:abc", protocol: "XRAY_VLESS_REALITY", bytesUp: "10", bytesDown: "20" },
    ]);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("ignores an empty delta rather than writing a zero-byte record", async () => {
    const { service, prisma } = build(user);

    await service.recordDeltas("node-1", [
      { externalUserId: "ext-1", protocol: "XRAY_TROJAN", bytesUp: "0", bytesDown: "0" },
    ]);

    expect(prisma.protocolUser.findFirst).not.toHaveBeenCalled();
  });
});
