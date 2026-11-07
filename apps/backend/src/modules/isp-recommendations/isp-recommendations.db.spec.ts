import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { IspRecommendationsService } from "./isp-recommendations.service";

/** The traffic query against a real, migrated Postgres -- what the unit
 * spec cannot check, since it stands in for $queryRaw: the column names,
 * the per-customer sum across a shared and a device credential, the
 * hourly grouping, the epoch of the bucket's end, the window's lower
 * bound, and the NULL route a removed credential leaves.
 *
 * Runs only with NEOXIFY_DB_SPECS=1, which CI sets for its own step after
 * applying every migration to the job's empty database. Never point it at
 * a database that matters: it writes rows, and removes only the ones it
 * wrote. Other specs may write usage in the same window, so it asserts on
 * its own route and network only. */

const enabled = process.env.NEOXIFY_DB_SPECS === "1";
const HOUR = 3_600_000;
const MIN = 60_000;
const MB = 1n << 20n;
// Private-use ASNs, so no real network's rows are mistaken for these.
const NET_X = 65101;
const NET_Y = 65102;

(enabled ? describe : describe.skip)("ISP recommendation traffic against Postgres", () => {
  let prisma: PrismaClient;
  let service: IspRecommendationsService;
  const tag = randomUUID().slice(0, 8);
  const now = Date.now();
  // The start of a clock hour two hours back, so every offset below lands
  // in the hour it names whatever minute the spec runs at.
  const hour = Math.floor(now / HOUR) * HOUR - 2 * HOUR;
  const ids = {
    customers: [] as string[],
    plan: "",
    node: "",
    config: "",
    route: "",
    session: "",
    subscriptions: [] as string[],
    protocolUsers: [] as string[],
  };

  beforeAll(async () => {
    prisma = new PrismaClient();
    service = new IspRecommendationsService(prisma as never, { orgOf: () => null } as never);

    const customers = await Promise.all(
      ["mover", "ghost", "removed"].map((who) =>
        prisma.customer.create({ data: { email: `isp-${tag}-${who}@example.test` }, select: { id: true } }),
      ),
    );
    const [mover, ghost, removed] = customers.map((c) => c.id);
    const plan = await prisma.subscriptionPlan.create({ data: { name: `isp-${tag}`, durationDays: 30, priceUsd: 1 } });
    const node = await prisma.node.create({ data: { name: `isp-${tag}`, region: "test", publicIp: "192.0.2.13" } });
    const config = await prisma.protocolConfig.create({
      data: { nodeId: node.id, protocol: "SHADOWSOCKS", listenPort: 23457, publicParamsJson: {} },
    });
    const route = await prisma.route.create({ data: { name: `isp-${tag}`, entryProtocolConfigId: config.id } });
    const subscriptions = await Promise.all(
      customers.map((c) =>
        prisma.subscription.create({
          data: { customerId: c.id, planId: plan.id, expireAt: new Date(now + 24 * HOUR) },
          select: { id: true },
        }),
      ),
    );
    const [moverSub, ghostSub, removedSub] = subscriptions.map((s) => s.id);
    const session = await prisma.customerSession.create({ data: { customerId: mover }, select: { id: true } });
    const credential = (subscriptionId: string, sessionId: string | null) =>
      prisma.protocolUser.create({
        data: {
          subscriptionId,
          routeId: route.id,
          nodeId: node.id,
          protocolConfigId: config.id,
          protocol: "SHADOWSOCKS",
          externalUserId: randomUUID(),
          credentialsJson: "not-read-by-this-spec",
          sessionId,
        },
        select: { id: true },
      });
    // The mover has the subscription's shared credential and one device's.
    const shared = await credential(moverSub, null);
    const device = await credential(moverSub, session.id);
    const ghostCredential = await credential(ghostSub, null);
    Object.assign(ids, {
      customers: [mover, ghost, removed],
      plan: plan.id,
      node: node.id,
      config: config.id,
      route: route.id,
      session: session.id,
      subscriptions: [moverSub, ghostSub, removedSub],
      protocolUsers: [shared.id, device.id, ghostCredential.id],
    });

    const report = (customerId: string, asn: number, at: number) => ({
      kind: "CONNECT" as const,
      outcome: "SUCCESS" as const,
      customerId,
      platform: "windows",
      appVersion: "0.9.57",
      routeId: route.id,
      attemptsJson: [{ protocol: "Fast", result: "connected", routeId: route.id, carried: true }],
      asn,
      occurredAt: new Date(at),
      createdAt: new Date(at),
    });
    await prisma.clientAttempt.createMany({
      data: [
        report(mover, NET_X, hour - 10 * HOUR),
        // Moved to another network five minutes into the last full hour.
        report(mover, NET_Y, hour + 5 * MIN),
        report(ghost, NET_X, hour - 10 * HOUR),
      ],
    });

    const usage = (subscriptionId: string, protocolUserId: string | null, at: number, up: bigint, down: bigint) => ({
      subscriptionId,
      protocolUserId,
      nodeId: node.id,
      periodStart: new Date(at - MIN),
      periodEnd: new Date(at),
      reportedAt: new Date(at),
      bytesUp: up,
      bytesDown: down,
    });
    await prisma.usageRecord.createMany({
      data: [
        // One hour, two of the mover's credentials, on network X.
        usage(moverSub, shared.id, hour - 6 * HOUR + 10 * MIN, 2n * MB, 10n * MB),
        usage(moverSub, device.id, hour - 6 * HOUR + 20 * MIN, 1n * MB, 5n * MB),
        // Before the move inside the window: still X.
        usage(moverSub, device.id, hour - HOUR + 40 * MIN, 1n * MB, 1n * MB),
        // After it: Y.
        usage(moverSub, device.id, hour + 30 * MIN, 4n * MB, 1n * MB),
        // Older than the window: nowhere.
        usage(moverSub, shared.id, now - 50 * HOUR, 999n * MB, 999n * MB),
        // A peer whose device has gone: download only.
        usage(ghostSub, ghostCredential.id, hour - 3 * HOUR, 0n, 500n * MB),
        // A credential removed since.
        usage(removedSub, null, hour - HOUR, 7n, 9n),
      ],
    });
  }, 60_000);

  afterAll(async () => {
    if (ids.customers.length) await prisma.clientAttempt.deleteMany({ where: { customerId: { in: ids.customers } } });
    if (ids.node) await prisma.usageRecord.deleteMany({ where: { nodeId: ids.node } });
    if (ids.protocolUsers.length) await prisma.protocolUser.deleteMany({ where: { id: { in: ids.protocolUsers } } });
    if (ids.session) await prisma.customerSession.delete({ where: { id: ids.session } });
    if (ids.subscriptions.length) await prisma.subscription.deleteMany({ where: { id: { in: ids.subscriptions } } });
    if (ids.route) await prisma.route.delete({ where: { id: ids.route } });
    if (ids.config) await prisma.protocolConfig.delete({ where: { id: ids.config } });
    if (ids.plan) await prisma.subscriptionPlan.delete({ where: { id: ids.plan } });
    if (ids.node) await prisma.node.delete({ where: { id: ids.node } });
    if (ids.customers.length) await prisma.customer.deleteMany({ where: { id: { in: ids.customers } } });
    await prisma?.$disconnect();
  });

  it("sums a customer's credentials, places each hour on its network, and skips nothing", async () => {
    const summary = await service.adminSummary(now);
    const onRoute = (asn: number) =>
      summary.networks.find((n) => n.asn === asn)?.routes.find((r) => r.routeId === ids.route);

    expect(onRoute(NET_X)?.traffic).toEqual({
      bytesUp: String(4n * MB),
      bytesDown: String(516n * MB),
      customers: 2,
      withUpload: 1,
      typicalBytes: String(20n * MB),
    });
    expect(onRoute(NET_Y)?.traffic).toEqual({
      bytesUp: String(4n * MB),
      bytesDown: String(1n * MB),
      customers: 1,
      withUpload: 1,
      typicalBytes: String(5n * MB),
    });
    expect(onRoute(NET_X)).toMatchObject({ tried: 2, carried: 2, routeName: `isp-${tag}`, nodeName: `isp-${tag}` });
    expect(summary.unattributed.find((r) => r.routeId === ids.route)).toBeUndefined();

    expect(summary.withoutRoute.customers).toBeGreaterThanOrEqual(1);
    expect(BigInt(summary.withoutRoute.bytesUp)).toBeGreaterThanOrEqual(7n);
    expect(BigInt(summary.withoutRoute.bytesDown)).toBeGreaterThanOrEqual(9n);
  });
});
