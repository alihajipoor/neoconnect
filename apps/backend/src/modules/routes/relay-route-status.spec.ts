import { RoutesService, UPLINK_FRESH_MS } from "./routes.service";

/** What the route list tells the apps about a relay route: down unless
 * BOTH halves have been confirmed recently -- the exit's uplink and the
 * entry's own outbound, rule and policy route. */
describe("relay route status in the route list", () => {
  const now = Date.now();
  const FRESH = new Date(now - 30_000);
  const STALE = new Date(now - UPLINK_FRESH_MS - 60_000);

  function statusOf(row: { exit: boolean; uplinkAssertedAt: Date | null; entryAssertedAt: Date | null }) {
    const prisma = {
      route: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "route-1",
            name: "Iran relay to France",
            exitProtocolConfigId: row.exit ? "cfg-exit" : null,
            exitProtocolConfig: row.exit ? { nodeId: "france-1" } : null,
            uplinkAssertedAt: row.uplinkAssertedAt,
            entryAssertedAt: row.entryAssertedAt,
            entryProtocolConfig: {
              protocol: "IKEV2",
              nodeId: "ir1",
              transport: null,
              listenPort: 500,
              node: { name: "ir1", region: "ir", publicIp: "198.51.100.10", status: "ONLINE", lastHeartbeatAt: new Date() },
            },
          },
        ]),
      },
    };
    const service = new RoutesService(prisma as never, {} as never, {} as never, { get: () => undefined } as never);
    return service
      .listAvailableForPlan(["IKEV2"] as never, ["route-1"], "customer-1")
      .then((routes) => routes[0].nodeStatus);
  }

  it("is the entry node's status when both halves are fresh", async () => {
    expect(await statusOf({ exit: true, uplinkAssertedAt: FRESH, entryAssertedAt: FRESH })).toBe("ONLINE");
  });

  /** Before, ONLINE: the exit's uplink was the only half that counted. */
  it("is down when the entry has never confirmed its half", async () => {
    expect(await statusOf({ exit: true, uplinkAssertedAt: FRESH, entryAssertedAt: null })).toBe("OFFLINE");
  });

  it("is down when the entry has stopped confirming it", async () => {
    expect(await statusOf({ exit: true, uplinkAssertedAt: FRESH, entryAssertedAt: STALE })).toBe("OFFLINE");
  });

  it("is still down when only the exit's half is missing", async () => {
    expect(await statusOf({ exit: true, uplinkAssertedAt: STALE, entryAssertedAt: FRESH })).toBe("OFFLINE");
  });

  it("does not apply to a direct route, which has neither half", async () => {
    expect(await statusOf({ exit: false, uplinkAssertedAt: null, entryAssertedAt: null })).toBe("ONLINE");
  });
});
