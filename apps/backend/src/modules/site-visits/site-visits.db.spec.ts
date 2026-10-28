import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { SiteVisitsService } from "./site-visits.service";

/** The site history against a real, migrated Postgres: that a batch maps
 * to the right customer through a real ProtocolUser and lands in
 * site_visits with every column the migration made, and that the
 * grouping, the case-insensitive search and the prune do what the
 * stand-in Prisma of the other spec only assumes.
 *
 * Runs only with NEOXIFY_DB_SPECS=1, which CI sets for its own step after
 * applying every migration to the job's empty database. Never point it at
 * a database that matters: it writes rows, removes the ones it wrote, and
 * its prune deletes every site_visits row older than seven days. */

const enabled = process.env.NEOXIFY_DB_SPECS === "1";
const DAY = 86_400_000;

(enabled ? describe : describe.skip)("site history against Postgres", () => {
  let prisma: PrismaClient;
  let service: SiteVisitsService;
  const tag = randomUUID().slice(0, 8);
  const ids = { customer: "", plan: "", node: "", config: "", route: "", subscription: "", protocolUser: "" };
  const externalUserId = randomUUID();
  const s = (ms: number) => String(Math.floor(ms / 1000));

  beforeAll(async () => {
    prisma = new PrismaClient();
    service = new SiteVisitsService(prisma as never, { lookup: () => ({ asn: 64500, org: "Example Net" }) } as never);
    const customer = await prisma.customer.create({ data: { email: `sv-${tag}@example.test` }, select: { id: true } });
    const plan = await prisma.subscriptionPlan.create({ data: { name: `sv-${tag}`, durationDays: 30, priceUsd: 1 } });
    const node = await prisma.node.create({ data: { name: `sv-${tag}`, region: "test", publicIp: "192.0.2.11" } });
    const config = await prisma.protocolConfig.create({
      data: { nodeId: node.id, protocol: "XRAY_VLESS_REALITY", listenPort: 443, publicParamsJson: {} },
    });
    const route = await prisma.route.create({ data: { name: `sv-${tag}`, entryProtocolConfigId: config.id } });
    const subscription = await prisma.subscription.create({
      data: { customerId: customer.id, planId: plan.id, expireAt: new Date(Date.now() + DAY) },
    });
    const protocolUser = await prisma.protocolUser.create({
      data: {
        subscriptionId: subscription.id,
        routeId: route.id,
        nodeId: node.id,
        protocolConfigId: config.id,
        protocol: "XRAY_VLESS_REALITY",
        externalUserId,
        credentialsJson: "not-read-by-this-spec",
      },
    });
    Object.assign(ids, {
      customer: customer.id,
      plan: plan.id,
      node: node.id,
      config: config.id,
      route: route.id,
      subscription: subscription.id,
      protocolUser: protocolUser.id,
    });
  }, 60_000);

  afterAll(async () => {
    if (ids.customer) await prisma.siteVisit.deleteMany({ where: { customerId: ids.customer } });
    if (ids.protocolUser) await prisma.protocolUser.delete({ where: { id: ids.protocolUser } });
    if (ids.subscription) await prisma.subscription.delete({ where: { id: ids.subscription } });
    if (ids.route) await prisma.route.delete({ where: { id: ids.route } });
    if (ids.config) await prisma.protocolConfig.delete({ where: { id: ids.config } });
    if (ids.plan) await prisma.subscriptionPlan.delete({ where: { id: ids.plan } });
    if (ids.node) await prisma.node.delete({ where: { id: ids.node } });
    if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } });
    await prisma?.$disconnect();
  });

  it("stores a batch under the credential's customer, groups it, searches it and prunes it", async () => {
    const now = Date.now();
    const line = (host: string, port: number, network: string, count: number, user: string = externalUserId) => ({
      externalUserId: user,
      inboundTag: "vless-in",
      network,
      host,
      port,
      count,
      firstSeen: s(now - 120_000),
      lastSeen: s(now - 60_000),
    });

    const first = await service.record(
      ids.node,
      {
        windowStart: s(now - 180_000),
        windowEnd: s(now),
        dropped: 0,
        destinations: [
          line("203.0.113.7", 443, "tcp", 2),
          line("Telegram.ORG", 443, "tcp", 1),
          line("198.51.100.9", 53, "udp", 1),
          // A relay uplink's identity: nobody's.
          line("203.0.113.8", 443, "tcp", 9, `route:${ids.route}`),
        ],
      },
      now,
    );
    const second = await service.record(
      ids.node,
      { windowStart: s(now - 60_000), windowEnd: s(now), dropped: 0, destinations: [line("203.0.113.7", 443, "tcp", 3)] },
      now,
    );
    expect([first, second]).toEqual([3, 1]);

    const stored = await prisma.siteVisit.findMany({
      where: { customerId: ids.customer },
      select: { nodeId: true, externalUserId: true, protocol: true, inboundTag: true },
    });
    expect(stored).toHaveLength(4);
    expect(stored[0]).toEqual({ nodeId: ids.node, externalUserId, protocol: "XRAY_VLESS_REALITY", inboundTag: "vless-in" });

    const all = await service.sites(ids.customer, {}, now);
    expect(all.total).toBe(3);
    const web = all.sites.find((x) => x.host === "203.0.113.7");
    expect(web).toMatchObject({
      port: 443,
      network: "tcp",
      owner: "Example Net",
      count: 5,
      servers: [`sv-${tag}`],
      protocols: ["XRAY_VLESS_REALITY"],
    });
    expect(all.sites.find((x) => x.host === "Telegram.ORG")?.owner).toBeNull();

    const searched = await service.sites(ids.customer, { q: "telegram" }, now);
    expect(searched.sites.map((x) => x.host)).toEqual(["Telegram.ORG"]);

    // A row eight days old goes; the fresh ones stay.
    await prisma.siteVisit.create({
      data: {
        customerId: ids.customer,
        nodeId: ids.node,
        externalUserId,
        inboundTag: "vless-in",
        network: "tcp",
        host: "203.0.113.200",
        port: 443,
        count: 1,
        firstSeen: new Date(now - 8 * DAY),
        lastSeen: new Date(now - 8 * DAY),
      },
    });
    expect(await service.prune(now)).toBeGreaterThanOrEqual(1);
    expect(await prisma.siteVisit.count({ where: { customerId: ids.customer } })).toBe(4);
  });
});
