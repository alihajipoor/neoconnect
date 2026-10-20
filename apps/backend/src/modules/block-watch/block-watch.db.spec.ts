import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { BlockWatchService, latestDialsSql } from "./block-watch.service";

/** The block watch's queries against a real Postgres, migrated from
 * nothing. The unit tests run on an in-memory stand-in; this is what
 * proves the grouped upstream count, the per-server latest answer, the
 * one-row-per-customer-and-route dial query and the digest bookkeeping
 * mean the same thing to Postgres.
 *
 * Skipped unless BLOCK_WATCH_DB_TEST=1 and DATABASE_URL points at a
 * database it may write to -- CI's own, in the TypeScript job, after
 * `prisma migrate deploy`. Uses documentation addresses only. */
const enabled = process.env.BLOCK_WATCH_DB_TEST === "1" && !!process.env.DATABASE_URL;
const describeDb = enabled ? describe : describe.skip;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ASNS = [64500, 64501];

describeDb("BlockWatchService against Postgres", () => {
  const prisma = new PrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ids = { node: "", customers: [] as string[], plan: "", subs: [] as string[], route: "" };
  const pages: { subject: string }[] = [];
  let service: BlockWatchService;
  const now = new Date();
  const t = now.getTime();

  beforeAll(async () => {
    const node = await prisma.node.create({
      data: { name: `bw-${tag}`, region: "test", publicIp: "192.0.2.77", status: "ONLINE" },
    });
    ids.node = node.id;
    const config = await prisma.protocolConfig.create({
      data: { nodeId: node.id, protocol: "XRAY_VLESS_REALITY", listenPort: 443, publicParamsJson: {} },
    });
    const route = await prisma.route.create({ data: { name: `bw-${tag}`, entryProtocolConfigId: config.id } });
    const plan = await prisma.subscriptionPlan.create({ data: { name: `bw-${tag}`, durationDays: 30, priceUsd: 1 } });
    ids.plan = plan.id;

    for (let i = 0; i < 14; i += 1) {
      const customer = await prisma.customer.create({ data: { email: `bw-${tag}-${i}@example.test` } });
      ids.customers.push(customer.id);
    }
    // Reports: the route carried on both networks two days ago, and has
    // carried nothing for four people on each in the last half hour --
    // people the server measured traffic for before (below).
    const report = (customerId: string, asn: number, carried: boolean, at: number) =>
      prisma.clientAttempt.create({
        data: {
          kind: "CONNECT",
          outcome: carried ? "SUCCESS" : "NOT_CARRYING_TRAFFIC",
          platform: "windows",
          appVersion: "0.9.51",
          customerId,
          asn,
          attemptsJson: [{ protocol: "Fast", result: "x", routeId: route.id, carried }],
          createdAt: new Date(at),
        },
      });
    for (const [n, asn] of ASNS.entries()) {
      for (let i = 0; i < 3; i += 1) await report(ids.customers[n * 7 + i], asn, true, t - 2 * DAY);
      for (let i = 3; i < 7; i += 1) await report(ids.customers[n * 7 + i], asn, false, t - 20 * MIN);
    }

    // Traffic: ten people on each of the last seven days at this hour;
    // today one sends real data and nine only a trickle upstream.
    for (let s = 0; s < 10; s += 1) {
      const sub = await prisma.subscription.create({
        data: { customerId: ids.customers[s], planId: plan.id, expireAt: new Date(t + 30 * DAY), status: "ACTIVE" },
      });
      ids.subs.push(sub.id);
      const rows = [];
      for (let day = 1; day <= 7; day += 1) {
        const at = new Date(t - day * DAY - 30 * MIN);
        // Two deltas a window, summed by the query.
        rows.push({ at, up: 15_000 }, { at, up: 15_000 });
      }
      rows.push({ at: new Date(t - 30 * MIN), up: s === 0 ? 50_000 : 1_000 });
      await prisma.usageRecord.createMany({
        data: rows.map((r) => ({
          subscriptionId: sub.id,
          nodeId: node.id,
          periodStart: r.at,
          periodEnd: r.at,
          bytesUp: BigInt(r.up),
          bytesDown: 0n,
          reportedAt: r.at,
        })),
      });
    }

    // The second network's four had used the server too, at an hour no
    // traffic window looks at.
    for (let i = 10; i < 14; i += 1) {
      const sub = await prisma.subscription.create({
        data: { customerId: ids.customers[i], planId: plan.id, expireAt: new Date(t + 30 * DAY), status: "ACTIVE" },
      });
      ids.subs.push(sub.id);
      const at = new Date(t - 2 * DAY - 6 * 60 * MIN);
      await prisma.usageRecord.create({
        data: { subscriptionId: sub.id, nodeId: node.id, periodStart: at, periodEnd: at, bytesUp: 50_000n, bytesDown: 0n, reportedAt: at },
      });
    }

    // One account flooding reports: hundreds, the newest last.
    await prisma.clientAttempt.createMany({
      data: Array.from({ length: 300 }, (_, i) => ({
        kind: "CONNECT" as const,
        outcome: "NOT_CARRYING_TRAFFIC" as const,
        platform: "windows",
        appVersion: "0.9.51",
        customerId: ids.customers[3],
        asn: ASNS[0],
        attemptsJson: [
          { protocol: "Fast", result: "x", routeId: route.id, carried: true },
          { protocol: "Fast", result: "x", routeId: route.id, carried: false },
        ],
        createdAt: new Date(t - 15 * MIN + i),
      })),
    });
    ids.route = route.id;

    const identity = { countryOfAsn: () => "IR", orgOf: () => "Example Carrier" };
    const pager = {
      page: async (p: { subject: string }) => {
        pages.push(p);
        return Promise.resolve({ webhook: true, mailed: [], failed: [], delivered: true, error: null });
      },
    };
    const configService = {
      get: (key: string) => ({ "blockWatch.mode": "notify", "reachability.country": "ir", "reachability.port": 443 })[key],
    };
    service = new BlockWatchService(prisma as never, configService as never, identity as never, pager as never);
    service.tcpReachable = () => Promise.resolve(true);
  });

  afterAll(async () => {
    await prisma.blockIncident.deleteMany({ where: { nodeId: ids.node } });
    await prisma.usageRecord.deleteMany({ where: { nodeId: ids.node } });
    await prisma.subscription.deleteMany({ where: { id: { in: ids.subs } } });
    await prisma.clientAttempt.deleteMany({ where: { customerId: { in: ids.customers } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids.customers } } });
    await prisma.subscriptionPlan.deleteMany({ where: { id: ids.plan } });
    await prisma.route.deleteMany({ where: { name: `bw-${tag}` } });
    await prisma.protocolConfig.deleteMany({ where: { nodeId: ids.node } });
    await prisma.node.deleteMany({ where: { id: ids.node } });
    await prisma.$disconnect();
  });

  it("reads one row per customer and route however many reports: the last rung of the latest", async () => {
    const rows = await prisma.$queryRaw<{ customerId: string; routeId: string; carried: boolean; rung: number; createdAt: Date }[]>(
      latestDialsSql(t - 3 * 60 * MIN, ASNS),
    );
    const mine = rows.filter((r) => r.routeId === ids.route);
    const flood = mine.filter((r) => r.customerId === ids.customers[3]);
    expect(flood).toHaveLength(1);
    // The later rung of the latest report decides: nothing carried.
    expect(flood[0]).toMatchObject({ carried: false, rung: 2 });
    expect(flood[0].createdAt).toBeInstanceOf(Date);
    // Everyone failing now, and nobody from two days ago.
    expect(new Set(mine.map((r) => r.customerId))).toEqual(new Set([3, 4, 5, 6, 10, 11, 12, 13].map((i) => ids.customers[i])));
    // Networks not asked for are not read.
    const other = await prisma.$queryRaw<{ routeId: string }[]>(latestDialsSql(t - 3 * 60 * MIN, [64999]));
    expect(other.filter((r) => r.routeId === ids.route)).toHaveLength(0);
  });

  it("finds the block from reports and the traffic cliff, and pages once", async () => {
    const [summary] = (await service.runCycle(now)).filter((s) => s.nodeName === `bw-${tag}`);
    expect(summary).toMatchObject({ verdict: "LIKELY_BLOCKED", outage: null });
    expect(summary.firing).toEqual(expect.arrayContaining(["client", "traffic"]));

    const incident = await prisma.blockIncident.findFirstOrThrow({
      where: { nodeId: ids.node, status: "OPEN" },
      select: {
        verdict: true,
        pagedAt: true,
        evidenceJson: true,
        publicIp: true,
        firedFamilies: true,
        failedAsns: true,
        pageAttempts: true,
      },
    });
    expect(incident.verdict).toBe("LIKELY_BLOCKED");
    expect([...incident.firedFamilies].sort()).toEqual(["client", "traffic"]);
    expect([...incident.failedAsns].sort()).toEqual(ASNS);
    expect(incident.pageAttempts).toBe(1);
    expect(incident.pagedAt).not.toBeNull();
    const traffic = (incident.evidenceJson as { families: { family: string; summary: string }[] }).families.find(
      (f) => f.family === "traffic",
    );
    expect(traffic?.summary).toContain("1 people sent data");
    expect(traffic?.summary).toContain("usually 10");
    expect(pages.filter((p) => p.subject.includes(`bw-${tag} is likely blocked`))).toHaveLength(1);

    const overview = await service.overview(now);
    expect(overview.open.some((i) => i.node.name === `bw-${tag}`)).toBe(true);
  });

  it("after Replaced, reads the owner's answer back and starts over", async () => {
    const open = await prisma.blockIncident.findFirstOrThrow({ where: { nodeId: ids.node, status: "OPEN" }, select: { id: true } });
    await expect(service.act(open.id, "replaced", "owner@example.test", {}, new Date(t + MIN))).rejects.toThrow(
      "still has the address",
    );
    await prisma.node.update({ where: { id: ids.node }, data: { publicIp: "192.0.2.78" } });
    await service.act(open.id, "replaced", "owner@example.test", {}, new Date(t + MIN));
    const later = new Date(t + 2 * MIN);
    const mine = (await service.runCycle(later)).filter((s) => s.nodeName === `bw-${tag}`);
    // Only today's trickle is after the answer: nothing to compare it to.
    expect(mine[0]?.verdict ?? null).toBeNull();
    expect(await prisma.blockIncident.count({ where: { nodeId: ids.node, status: "OPEN" } })).toBe(0);
  });
});
