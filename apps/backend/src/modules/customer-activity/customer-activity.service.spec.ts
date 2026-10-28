import { NotFoundException } from "@nestjs/common";
import { CustomerActivityService, LIVE_WINDOW_MS, parseRungs } from "./customer-activity.service";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const MIN = 60_000;
const ROUTE_DIRECT = "11111111-1111-4111-8111-111111111111";
const ROUTE_RELAY = "22222222-2222-4222-8222-222222222222";
const ROUTE_GONE = "33333333-3333-4333-8333-333333333333";

function build() {
  const prisma = {
    customer: { findUnique: jest.fn().mockResolvedValue({ id: "cust-1" }) },
    subscription: {
      findMany: jest.fn(({ where }: { where: { customerId?: string; id?: { in: string[] } } }) =>
        Promise.resolve(
          where.customerId
            ? [{ id: "sub-1" }, { id: "sub-0" }]
            : [
                { id: "sub-1", customerId: "cust-1", customer: { email: "a@example.test" } },
                { id: "sub-9", customerId: "cust-9", customer: { email: "z@example.test" } },
              ].filter((s) => (where.id?.in ?? []).includes(s.id)),
        ),
      ),
    },
    node: {
      findMany: jest.fn().mockResolvedValue([
        { id: "node-1", name: "alpha", publicIp: "203.0.113.1" },
        { id: "node-2", name: "beta", publicIp: "203.0.113.2" },
        { id: "node-3", name: "gamma", publicIp: "203.0.113.3" },
      ]),
    },
    usageRecord: {
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    protocolUser: {
      findMany: jest.fn().mockResolvedValue([
        { id: "pu-1", protocol: "XRAY_VLESS_REALITY" },
        { id: "pu-2", protocol: "SHADOWSOCKS" },
      ]),
    },
    customerSession: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
    clientAttempt: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    route: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const asn = { orgOf: jest.fn((n: number) => (n === 58224 ? "TCI" : n === 64500 ? "" : null)) };
  const auth = { revokeSession: jest.fn().mockResolvedValue(undefined) };
  const service = new CustomerActivityService(prisma as any, asn as any, auth as any);
  jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
  return { prisma, asn, auth, service };
}

const attempt = (over: Record<string, unknown> = {}) => ({
  id: "att-1",
  kind: "CONNECT",
  outcome: "TUNNEL_NO_TRAFFIC",
  platform: "windows",
  appVersion: "0.9.56",
  asn: 58224,
  ip: "198.51.100.20",
  via: null,
  protocol: "Stealth",
  reason: "every server tried",
  sessionSeconds: null,
  attemptsJson: null,
  occurredAt: null,
  createdAt: new Date(NOW - 5 * MIN),
  ...over,
});

describe("CustomerActivityService.activity", () => {
  it("names each rung's server, a relayed route as entry -> exit, and the network by its operator", async () => {
    const { service, prisma } = build();
    prisma.clientAttempt.findMany.mockResolvedValue([
      attempt({
        attemptsJson: [
          { protocol: "Fast", result: "up but unreachable", routeId: ROUTE_DIRECT, carried: false },
          { protocol: "Stealth", result: "connected", routeId: ROUTE_RELAY, carried: true },
          { protocol: "Stealth HTTPS", result: "refused", routeId: ROUTE_GONE },
          { protocol: "IKEv2", result: "not available with selected apps" },
        ],
        occurredAt: new Date(NOW - 3 * 3_600_000),
      }),
      attempt({ id: "att-2", asn: null, ip: null, attemptsJson: "not an array" }),
      attempt({ id: "att-3", asn: 64500 }),
    ]);
    prisma.route.findMany.mockResolvedValue([
      { id: ROUTE_DIRECT, entryProtocolConfig: { node: { name: "alpha" } }, exitProtocolConfig: null },
      { id: ROUTE_RELAY, entryProtocolConfig: { node: { name: "relay-1" } }, exitProtocolConfig: { node: { name: "beta" } } },
    ]);

    const { attempts } = await service.activity("cust-1", {}, NOW);

    expect([...(prisma.route.findMany.mock.calls[0][0].where.id.in as string[])].sort()).toEqual([ROUTE_DIRECT, ROUTE_GONE, ROUTE_RELAY].sort());
    expect(attempts[0]).toEqual({
      id: "att-1",
      // When it happened, not when the queued report finally arrived.
      at: new Date(NOW - 3 * 3_600_000).toISOString(),
      kind: "CONNECT",
      outcome: "TUNNEL_NO_TRAFFIC",
      platform: "windows",
      appVersion: "0.9.56",
      network: { asn: 58224, name: "TCI" },
      ip: "198.51.100.20",
      throughServer: null,
      noAddress: null,
      server: null,
      protocol: "Stealth",
      reason: "every server tried",
      sessionSeconds: null,
      rungs: [
        { protocol: "Fast", server: "alpha", result: "up but unreachable", carried: false },
        { protocol: "Stealth", server: "relay-1 -> beta", result: "connected", carried: true },
        { protocol: "Stealth HTTPS", server: null, result: "refused", carried: null },
        { protocol: "IKEv2", server: null, result: "not available with selected apps", carried: null },
      ],
    });
    expect(attempts[1]).toMatchObject({ at: new Date(NOW - 5 * MIN).toISOString(), network: null, ip: null, rungs: [] });
    // A network the table has no name for still says its number.
    expect(attempts[2].network).toEqual({ asn: 64500, name: null });
  });

  /** A success report goes out through the tunnel it has just opened, so
   * it arrives from the server: 555 of 616 in three days (2026-10-28). The
   * panel showed the server's address as the customer's. */
  it("names the server a report came through instead of giving its address as the customer's", async () => {
    const { service, prisma } = build();
    prisma.clientAttempt.findMany.mockResolvedValue([attempt({ id: "att-through", ip: "203.0.113.2" })]);
    const { attempts } = await service.activity("cust-1", {}, NOW);
    expect(attempts[0]).toMatchObject({ ip: null, throughServer: "beta" });
  });

  /** A blank "From address" reads as a fault. Where the reason is known,
   * the panel says it. */
  it("says why a row has no address, where that is known", async () => {
    const { service, prisma } = build();
    prisma.clientAttempt.findMany.mockResolvedValue([
      attempt({ id: "att-old", ip: null, createdAt: new Date(NOW - 15 * 86_400_000) }),
      attempt({ id: "att-relay", ip: null, via: "relay" }),
      attempt({ id: "att-none", ip: null }),
      attempt({ id: "att-kept", createdAt: new Date(NOW - 15 * 86_400_000) }),
    ]);
    const { attempts } = await service.activity("cust-1", {}, NOW);
    expect(attempts.map((a) => a.noAddress)).toEqual(["erased", "relay", null, null]);
  });

  it("bounds the attempts it reads", async () => {
    const { service, prisma } = build();

    await service.activity("cust-1", {}, NOW);
    await service.activity("cust-1", { attemptsTake: "10" }, NOW);
    await service.activity("cust-1", { attemptsTake: "100000" }, NOW);

    expect(prisma.clientAttempt.findMany.mock.calls.map((c: any[]) => c[0].take)).toEqual([50, 10, 200]);
    expect(prisma.clientAttempt.findMany.mock.calls[0][0].where).toEqual({ customerId: "cust-1" });
  });

  it("is connected now only on traffic counted in the last ten minutes, and says where", async () => {
    const { service, prisma } = build();
    prisma.usageRecord.groupBy.mockResolvedValue([
      {
        subscriptionId: "sub-1",
        nodeId: "node-1",
        protocolUserId: "pu-1",
        _sum: { bytesUp: 1_000n, bytesDown: 9_000n },
        _max: { periodEnd: new Date(NOW - 4 * MIN) },
      },
      {
        subscriptionId: "sub-1",
        nodeId: "node-2",
        protocolUserId: "pu-2",
        _sum: { bytesUp: 5n, bytesDown: 5n },
        _max: { periodEnd: new Date(NOW - MIN) },
      },
    ]);

    const { now } = await service.activity("cust-1", {}, NOW);

    const where = prisma.usageRecord.groupBy.mock.calls[0][0].where;
    expect(where.subscriptionId).toEqual({ in: ["sub-1", "sub-0"] });
    expect(where.periodEnd).toEqual({ gte: new Date(NOW - LIVE_WINDOW_MS) });
    expect((where.reportedAt.gte as Date).getTime()).toBeLessThanOrEqual(NOW - LIVE_WINDOW_MS);
    expect(now.connected).toEqual({
      nodeName: "beta",
      protocol: "SHADOWSOCKS",
      lastTrafficAt: new Date(NOW - MIN).toISOString(),
      bytesLast10Min: "10",
    });
  });

  it("is not connected without recent traffic, and last seen is the newest thing the server heard", async () => {
    const { service, prisma } = build();
    prisma.usageRecord.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.subscriptionId === "sub-1" ? { reportedAt: new Date(NOW - 2 * 3_600_000) } : null),
    );
    prisma.customerSession.findMany.mockResolvedValue([
      {
        id: "s-1",
        platform: "android",
        label: "Pixel 7",
        channel: "NORMAL",
        createdAt: new Date(NOW - 30 * 86_400_000),
        lastUsedAt: new Date(NOW - 90 * MIN),
        revokedAt: null,
      },
    ]);

    const { now } = await service.activity("cust-1", {}, NOW);

    expect(now.connected).toBeNull();
    expect(now.lastSeenAt).toBe(new Date(NOW - 90 * MIN).toISOString());
  });

  it("lists devices, revoked ones too, each with the newest app version its platform reported", async () => {
    const { service, prisma } = build();
    prisma.customerSession.findMany.mockResolvedValue([
      {
        id: "s-1",
        platform: "android",
        label: "Pixel 7",
        channel: "NORMAL",
        createdAt: new Date(NOW - 86_400_000),
        lastUsedAt: new Date(NOW - MIN),
        revokedAt: null,
      },
      {
        id: "s-2",
        platform: "windows",
        label: null,
        channel: null,
        createdAt: new Date(NOW - 9 * 86_400_000),
        lastUsedAt: new Date(NOW - 8 * 86_400_000),
        revokedAt: new Date(NOW - 8 * 86_400_000),
      },
      {
        id: "s-3",
        platform: null,
        label: null,
        channel: null,
        createdAt: new Date(NOW - 86_400_000),
        lastUsedAt: new Date(NOW - 86_400_000),
        revokedAt: null,
      },
    ]);
    prisma.clientAttempt.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.platform === "android" ? { appVersion: "0.2.34" } : null),
    );

    const { devices } = await service.activity("cust-1", {}, NOW);

    expect(prisma.clientAttempt.findFirst.mock.calls.map((c: any[]) => c[0].where)).toEqual([
      { customerId: "cust-1", platform: "android" },
      { customerId: "cust-1", platform: "windows" },
    ]);
    expect(devices).toEqual([
      {
        sessionId: "s-1",
        platform: "android",
        label: "Pixel 7",
        channel: "NORMAL",
        createdAt: new Date(NOW - 86_400_000).toISOString(),
        lastUsedAt: new Date(NOW - MIN).toISOString(),
        revoked: false,
        appVersion: "0.2.34",
      },
      expect.objectContaining({ sessionId: "s-2", revoked: true, appVersion: null }),
      expect.objectContaining({ sessionId: "s-3", platform: null, appVersion: null }),
    ]);
  });

  it("gives traffic per UTC day, server and protocol, newest day first, bytes as strings", async () => {
    const { service, prisma } = build();
    prisma.$queryRaw.mockResolvedValue([
      { day: "2026-10-27", nodeId: "node-1", protocol: "XRAY_VLESS_REALITY", up: "10", down: "20" },
      { day: "2026-10-28", nodeId: "node-2", protocol: null, up: "1", down: "2" },
      { day: "2026-10-28", nodeId: "node-2", protocol: null, up: "3", down: "4" },
      { day: "2026-10-28", nodeId: "node-1", protocol: "SHADOWSOCKS", up: "9007199254740993", down: "0" },
    ]);

    const { traffic } = await service.activity("cust-1", {}, NOW);

    expect(traffic).toEqual([
      { day: "2026-10-28", nodeName: "alpha", protocol: "SHADOWSOCKS", bytesUp: "9007199254740993", bytesDown: "0" },
      { day: "2026-10-28", nodeName: "beta", protocol: "unknown", bytesUp: "4", bytesDown: "6" },
      { day: "2026-10-27", nodeName: "alpha", protocol: "XRAY_VLESS_REALITY", bytesUp: "10", bytesDown: "20" },
    ]);
    // Fourteen days, today included: from UTC midnight thirteen days back.
    const values = (prisma.$queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(values).toContain("cust-1");
    expect(values).toContain(new Date(Date.UTC(2026, 9, 15)).toISOString());
  });

  it("asks nothing about traffic for a customer with no subscription", async () => {
    const { service, prisma } = build();
    prisma.subscription.findMany.mockResolvedValue([]);

    const result = await service.activity("cust-1", {}, NOW);

    expect(result.traffic).toEqual([]);
    expect(result.now.connected).toBeNull();
    expect(prisma.usageRecord.groupBy).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("is a 404 for a customer that does not exist", async () => {
    const { service, prisma } = build();
    prisma.customer.findUnique.mockResolvedValue(null);

    await expect(service.activity("nobody", {}, NOW)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("CustomerActivityService.live", () => {
  it("folds to one row per customer, server and protocol, newest first, across every node", async () => {
    const { service, prisma } = build();
    prisma.usageRecord.groupBy.mockResolvedValue([
      // Two credentials of one customer on one server and protocol (two
      // devices): one row.
      {
        subscriptionId: "sub-1",
        nodeId: "node-1",
        protocolUserId: "pu-1",
        _sum: { bytesUp: 100n, bytesDown: 200n },
        _max: { periodEnd: new Date(NOW - 8 * MIN) },
      },
      {
        subscriptionId: "sub-1",
        nodeId: "node-1",
        protocolUserId: "pu-1b",
        _sum: { bytesUp: 1n, bytesDown: 2n },
        _max: { periodEnd: new Date(NOW - 7 * MIN) },
      },
      {
        subscriptionId: "sub-9",
        nodeId: "node-3",
        protocolUserId: null,
        _sum: { bytesUp: 0n, bytesDown: 50n },
        _max: { periodEnd: new Date(NOW - MIN) },
      },
    ]);
    prisma.protocolUser.findMany.mockResolvedValue([
      { id: "pu-1", protocol: "XRAY_VLESS_REALITY" },
      { id: "pu-1b", protocol: "XRAY_VLESS_REALITY" },
    ]);

    const result = await service.live(NOW);

    const where = prisma.usageRecord.groupBy.mock.calls[0][0].where;
    expect(where.nodeId).toEqual({ in: ["node-1", "node-2", "node-3"] });
    expect(where.subscriptionId).toBeUndefined();
    expect(result).toEqual({
      at: new Date(NOW).toISOString(),
      users: [
        {
          customerId: "cust-9",
          email: "z@example.test",
          nodeName: "gamma",
          protocol: "unknown",
          lastTrafficAt: new Date(NOW - MIN).toISOString(),
          bytesLast10Min: "50",
        },
        {
          customerId: "cust-1",
          email: "a@example.test",
          nodeName: "alpha",
          protocol: "XRAY_VLESS_REALITY",
          lastTrafficAt: new Date(NOW - 7 * MIN).toISOString(),
          bytesLast10Min: "303",
        },
      ],
    });
  });

  it("is empty, not an error, when nothing is flowing", async () => {
    const { service } = build();

    expect(await service.live(NOW)).toEqual({ at: new Date(NOW).toISOString(), users: [] });
  });
});

describe("CustomerActivityService.signOutSession", () => {
  it("signs out the customer's own session through the same path as the app", async () => {
    const { service, prisma, auth } = build();
    prisma.customerSession.findFirst.mockResolvedValue({ id: "s-1" });

    expect(await service.signOutSession("cust-1", "s-1", "support@example.test")).toEqual({ ok: true });
    expect(prisma.customerSession.findFirst.mock.calls[0][0].where).toEqual({ id: "s-1", customerId: "cust-1" });
    expect(auth.revokeSession).toHaveBeenCalledWith("cust-1", "s-1");
  });

  it("is a 404 for another customer's session, and touches nothing", async () => {
    const { service, prisma, auth } = build();
    prisma.customerSession.findFirst.mockResolvedValue(null);

    await expect(service.signOutSession("cust-1", "s-of-someone-else", "x")).rejects.toBeInstanceOf(NotFoundException);
    expect(auth.revokeSession).not.toHaveBeenCalled();
  });
});

describe("parseRungs", () => {
  it("reads what clients send and survives what they should not", () => {
    expect(parseRungs(null)).toEqual([]);
    expect(parseRungs({ protocol: "Fast" } as any)).toEqual([]);
    expect(parseRungs([1, "x", null, ["a"], { protocol: 7, result: "ok", routeId: "", carried: "yes" }] as any)).toEqual([
      { protocol: null, routeId: null, result: "ok", carried: null },
    ]);
  });
});
