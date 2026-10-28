import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { CustomerActivityService } from "./customer-activity.service";

/** The customer activity reads against a real, migrated Postgres -- what
 * the other spec cannot check, since it stands in for Prisma: the raw
 * traffic query's columns and types, its UTC day on a TIMESTAMP(3)
 * column, the protocol it joins from the credential (and the NULL left
 * by a deleted one), and the live window's groupBy across real indexes.
 *
 * Runs only with NEOXIFY_DB_SPECS=1, which CI sets for its own step after
 * applying every migration to the job's empty database. Never point it at
 * a database that matters: it writes rows, and removes only the ones it
 * wrote. */

const enabled = process.env.NEOXIFY_DB_SPECS === "1";
const DAY = 86_400_000;
const MIN = 60_000;

(enabled ? describe : describe.skip)("customer activity against Postgres", () => {
  let prisma: PrismaClient;
  let service: CustomerActivityService;
  const tag = randomUUID().slice(0, 8);
  const ids = {
    customer: "",
    stranger: "",
    plan: "",
    node: "",
    config: "",
    route: "",
    subscription: "",
    strangerSubscription: "",
    protocolUser: "",
  };
  const now = Date.now();
  const todayMidnight = Math.floor(now / DAY) * DAY;
  const yesterdayMidnight = todayMidnight - DAY;
  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const rows: { at: number; up: bigint; down: bigint; credential: boolean; mine: boolean }[] = [
    // Either side of yesterday's UTC midnight: two different days.
    { at: yesterdayMidnight - 30_000, up: 1n, down: 10n, credential: true, mine: true },
    { at: yesterdayMidnight + 30_000, up: 2n, down: 9_007_199_254_740_993n, credential: true, mine: true },
    // Same day, from a credential deleted since.
    { at: yesterdayMidnight + 60_000, up: 4n, down: 40n, credential: false, mine: true },
    // Flowing now.
    { at: now - 2 * MIN, up: 100n, down: 200n, credential: true, mine: true },
    // Older than the fourteen days shown.
    { at: now - 20 * DAY, up: 7n, down: 7n, credential: true, mine: true },
    // Someone else's, flowing now: never this customer's.
    { at: now - MIN, up: 5_000n, down: 5_000n, credential: false, mine: false },
  ];

  beforeAll(async () => {
    prisma = new PrismaClient();
    service = new CustomerActivityService(prisma as never, { orgOf: () => null } as never, {} as never);
    const customer = await prisma.customer.create({ data: { email: `ca-${tag}@example.test` }, select: { id: true } });
    const stranger = await prisma.customer.create({ data: { email: `ca-${tag}-other@example.test` }, select: { id: true } });
    const plan = await prisma.subscriptionPlan.create({ data: { name: `ca-${tag}`, durationDays: 30, priceUsd: 1 } });
    const node = await prisma.node.create({ data: { name: `ca-${tag}`, region: "test", publicIp: "192.0.2.12" } });
    const config = await prisma.protocolConfig.create({
      data: { nodeId: node.id, protocol: "SHADOWSOCKS", listenPort: 23456, publicParamsJson: {} },
    });
    const route = await prisma.route.create({ data: { name: `ca-${tag}`, entryProtocolConfigId: config.id } });
    const subscription = await prisma.subscription.create({
      data: { customerId: customer.id, planId: plan.id, expireAt: new Date(now + DAY) },
    });
    const strangerSubscription = await prisma.subscription.create({
      data: { customerId: stranger.id, planId: plan.id, expireAt: new Date(now + DAY) },
    });
    const protocolUser = await prisma.protocolUser.create({
      data: {
        subscriptionId: subscription.id,
        routeId: route.id,
        nodeId: node.id,
        protocolConfigId: config.id,
        protocol: "SHADOWSOCKS",
        externalUserId: randomUUID(),
        credentialsJson: "not-read-by-this-spec",
      },
    });
    Object.assign(ids, {
      customer: customer.id,
      stranger: stranger.id,
      plan: plan.id,
      node: node.id,
      config: config.id,
      route: route.id,
      subscription: subscription.id,
      strangerSubscription: strangerSubscription.id,
      protocolUser: protocolUser.id,
    });
    await prisma.usageRecord.createMany({
      data: rows.map((r) => ({
        subscriptionId: r.mine ? subscription.id : strangerSubscription.id,
        protocolUserId: r.credential ? protocolUser.id : null,
        nodeId: node.id,
        periodStart: new Date(r.at - 30_000),
        periodEnd: new Date(r.at),
        reportedAt: new Date(r.at),
        bytesUp: r.up,
        bytesDown: r.down,
      })),
    });
  }, 60_000);

  afterAll(async () => {
    if (ids.node) await prisma.usageRecord.deleteMany({ where: { nodeId: ids.node } });
    if (ids.protocolUser) await prisma.protocolUser.delete({ where: { id: ids.protocolUser } });
    const subscriptions = [ids.subscription, ids.strangerSubscription].filter(Boolean);
    await prisma.subscription.deleteMany({ where: { id: { in: subscriptions } } });
    if (ids.route) await prisma.route.delete({ where: { id: ids.route } });
    if (ids.config) await prisma.protocolConfig.delete({ where: { id: ids.config } });
    if (ids.plan) await prisma.subscriptionPlan.delete({ where: { id: ids.plan } });
    if (ids.node) await prisma.node.delete({ where: { id: ids.node } });
    await prisma.customer.deleteMany({ where: { id: { in: [ids.customer, ids.stranger].filter(Boolean) } } });
    await prisma?.$disconnect();
  });

  it("gives traffic per UTC day, server and protocol, exactly, for this customer only", async () => {
    const { traffic, now: current } = await service.activity(ids.customer, {}, now);

    const expected = new Map<string, { day: string; protocol: string; up: bigint; down: bigint }>();
    for (const r of rows.filter((x) => x.mine && x.at >= todayMidnight - 13 * DAY)) {
      const protocol = r.credential ? "SHADOWSOCKS" : "unknown";
      const key = `${dayOf(r.at)} ${protocol}`;
      const e = expected.get(key) ?? { day: dayOf(r.at), protocol, up: 0n, down: 0n };
      e.up += r.up;
      e.down += r.down;
      expected.set(key, e);
    }
    expect(traffic).toEqual(
      [...expected.values()]
        .sort((a, b) => b.day.localeCompare(a.day) || a.protocol.localeCompare(b.protocol))
        .map((e) => ({ day: e.day, nodeName: `ca-${tag}`, protocol: e.protocol, bytesUp: String(e.up), bytesDown: String(e.down) })),
    );
    // The two rows a minute apart across midnight are on different days.
    expect(new Set(traffic.map((t) => t.day)).size).toBeGreaterThanOrEqual(2);

    expect(current.connected).toEqual({
      nodeName: `ca-${tag}`,
      protocol: "SHADOWSOCKS",
      lastTrafficAt: new Date(now - 2 * MIN).toISOString(),
      bytesLast10Min: "300",
    });
  });

  it("lists everyone flowing now, each with their own server and bytes", async () => {
    const { users } = await service.live(now);
    const mine = users.filter((u) => u.customerId === ids.customer || u.customerId === ids.stranger);

    expect(mine).toEqual([
      {
        customerId: ids.stranger,
        email: `ca-${tag}-other@example.test`,
        nodeName: `ca-${tag}`,
        protocol: "unknown",
        lastTrafficAt: new Date(now - MIN).toISOString(),
        bytesLast10Min: "10000",
      },
      {
        customerId: ids.customer,
        email: `ca-${tag}@example.test`,
        nodeName: `ca-${tag}`,
        protocol: "SHADOWSOCKS",
        lastTrafficAt: new Date(now - 2 * MIN).toISOString(),
        bytesLast10Min: "300",
      },
    ]);
  });
});
