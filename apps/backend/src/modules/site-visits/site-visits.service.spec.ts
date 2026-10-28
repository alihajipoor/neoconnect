import { NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  addressOf,
  boundedInt,
  MAX_DESTINATIONS_PER_BATCH,
  MAX_DESTINATIONS_PER_CUSTOMER_PER_BATCH,
  SITE_COVERAGE,
  SITE_VISIT_RETENTION_DAYS,
  SiteVisitsService,
} from "./site-visits.service";
import type { DestinationBatchMessage, DestinationCountMessage } from "../agent-gateway/agent-messages";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const S = (ms: number) => String(Math.floor(ms / 1000));
const DAY = 86_400_000;

function destination(over: Partial<DestinationCountMessage> = {}): DestinationCountMessage {
  return {
    externalUserId: "user-a",
    inboundTag: "vless-in",
    network: "tcp",
    host: "203.0.113.7",
    port: 443,
    count: 3,
    firstSeen: S(NOW - 50_000),
    lastSeen: S(NOW - 10_000),
    ...over,
  };
}

function batch(destinations: DestinationCountMessage[], over: Partial<DestinationBatchMessage> = {}): DestinationBatchMessage {
  return { windowStart: S(NOW - 60_000), windowEnd: S(NOW), destinations, dropped: 0, ...over };
}

function build(owners: { externalUserId: string; protocol: string; customerId: string }[] = []) {
  const prisma = {
    protocolUser: {
      findMany: jest.fn(({ where }: { where: { nodeId: string; externalUserId: { in: string[] } } }) =>
        Promise.resolve(
          owners
            .filter((o) => where.externalUserId.in.includes(o.externalUserId) && where.nodeId === "node-1")
            .map((o) => ({ externalUserId: o.externalUserId, protocol: o.protocol, subscription: { customerId: o.customerId } })),
        ),
      ),
    },
    siteVisit: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [Prisma.Sql]>().mockResolvedValue([]),
    customer: { findUnique: jest.fn().mockResolvedValue({ id: "cust-1" }) },
    node: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const asn = { lookup: jest.fn().mockReturnValue(null) };
  const service = new SiteVisitsService(prisma as any, asn as any);
  const warn = jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
  jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
  jest.spyOn(service["logger"], "debug").mockImplementation(() => undefined);
  const written = () => prisma.siteVisit.createMany.mock.calls.flatMap((c: any[]) => c[0].data);
  return { prisma, asn, service, written, warn };
}

describe("SiteVisitsService.record", () => {
  it("files each destination under the customer who owns that credential on that node", async () => {
    const { service, prisma, written } = build([
      { externalUserId: "user-a", protocol: "XRAY_VLESS_REALITY", customerId: "cust-1" },
      { externalUserId: "user-b", protocol: "SHADOWSOCKS", customerId: "cust-2" },
    ]);

    const n = await service.record(
      "node-1",
      batch([destination(), destination({ externalUserId: "user-b", host: "example.org", port: 80, inboundTag: "shadowsocks-in" })]),
      NOW,
    );

    expect(n).toBe(2);
    // Looked up on the node the stream authenticated as, not across nodes.
    expect(prisma.protocolUser.findMany.mock.calls[0][0].where.nodeId).toBe("node-1");
    expect(written()).toEqual([
      expect.objectContaining({
        customerId: "cust-1",
        nodeId: "node-1",
        externalUserId: "user-a",
        protocol: "XRAY_VLESS_REALITY",
        inboundTag: "vless-in",
        network: "tcp",
        host: "203.0.113.7",
        port: 443,
        count: 3,
        firstSeen: new Date(Number(S(NOW - 50_000)) * 1000),
        lastSeen: new Date(Number(S(NOW - 10_000)) * 1000),
      }),
      expect.objectContaining({ customerId: "cust-2", protocol: "SHADOWSOCKS", host: "example.org", port: 80 }),
    ]);
  });

  it("drops what names no customer: a relay's uplink credential, a deleted user", async () => {
    const { service, written } = build([{ externalUserId: "user-a", protocol: "XRAY_VLESS_REALITY", customerId: "cust-1" }]);

    const n = await service.record(
      "node-1",
      batch([destination({ externalUserId: "route:0f1e" }), destination({ externalUserId: "gone" }), destination()]),
      NOW,
    );

    expect(n).toBe(1);
    expect(written().map((r: any) => r.externalUserId)).toEqual(["user-a"]);
  });

  it("does not match a credential that exists only on another node", async () => {
    const { service, prisma } = build([{ externalUserId: "user-a", protocol: "XRAY_VLESS_REALITY", customerId: "cust-1" }]);

    expect(await service.record("node-2", batch([destination()]), NOW)).toBe(0);
    expect(prisma.siteVisit.createMany).not.toHaveBeenCalled();
  });

  it("remembers owners between batches, and asks again once that has lapsed", async () => {
    const { service, prisma } = build([{ externalUserId: "user-a", protocol: "XRAY_VLESS_REALITY", customerId: "cust-1" }]);

    await service.record("node-1", batch([destination()]), NOW);
    await service.record("node-1", batch([destination()]), NOW + 60_000);
    expect(prisma.protocolUser.findMany).toHaveBeenCalledTimes(1);

    await service.record("node-1", batch([destination()]), NOW + 6 * 60_000);
    expect(prisma.protocolUser.findMany).toHaveBeenCalledTimes(2);
  });

  it("forgets an unknown credential sooner, so one created moments ago is not shut out for long", async () => {
    const owners: { externalUserId: string; protocol: string; customerId: string }[] = [];
    const { service, written } = build(owners);

    expect(await service.record("node-1", batch([destination()]), NOW)).toBe(0);
    owners.push({ externalUserId: "user-a", protocol: "XRAY_VLESS_REALITY", customerId: "cust-1" });
    expect(await service.record("node-1", batch([destination()]), NOW + 30_000)).toBe(0);
    expect(await service.record("node-1", batch([destination()]), NOW + 61_000)).toBe(1);
    expect(written()).toHaveLength(1);
  });

  it("caps one batch and writes in chunks", async () => {
    // Six customers, each under their own share, so the batch's cap is
    // the one that bites.
    const owners = Array.from({ length: 6 }, (_, i) => ({
      externalUserId: `user-${i}`,
      protocol: "XRAY_VLESS_REALITY",
      customerId: `cust-${i}`,
    }));
    const { service, prisma } = build(owners);
    const many = Array.from({ length: MAX_DESTINATIONS_PER_BATCH + 250 }, (_, i) =>
      destination({ externalUserId: `user-${i % 6}`, port: i % 65_535 }),
    );

    const n = await service.record("node-1", batch(many), NOW);

    expect(n).toBe(MAX_DESTINATIONS_PER_BATCH);
    for (const call of prisma.siteVisit.createMany.mock.calls) expect(call[0].data.length).toBeLessThanOrEqual(1_000);
  });

  it("holds one customer to a share of a batch, across all their credentials, and still stores everyone else", async () => {
    const { service, written, warn } = build([
      { externalUserId: "phone", protocol: "XRAY_VLESS_REALITY", customerId: "cust-1" },
      { externalUserId: "laptop", protocol: "SHADOWSOCKS", customerId: "cust-1" },
      { externalUserId: "user-b", protocol: "XRAY_VLESS_REALITY", customerId: "cust-2" },
    ]);
    const spray = (user: string, n: number) =>
      Array.from({ length: n }, (_, i) => destination({ externalUserId: user, host: `198.51.100.${i % 256}`, port: 1 + i }));

    const n = await service.record(
      "node-1",
      batch([...spray("phone", 700), ...spray("laptop", 700), ...spray("user-b", 10)]),
      NOW,
    );

    const rows = written();
    expect(rows.filter((r: any) => r.customerId === "cust-1")).toHaveLength(MAX_DESTINATIONS_PER_CUSTOMER_PER_BATCH);
    expect(rows.filter((r: any) => r.customerId === "cust-2")).toHaveLength(10);
    expect(n).toBe(MAX_DESTINATIONS_PER_CUSTOMER_PER_BATCH + 10);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/400 destination\(s\) not stored/));
  });

  it("keeps times honest: missing ones from the window, a fast clock pulled back to now, first never after last", async () => {
    const { service, written } = build([{ externalUserId: "user-a", protocol: "XRAY_VLESS_REALITY", customerId: "cust-1" }]);

    await service.record(
      "node-1",
      batch([
        destination({ firstSeen: "0", lastSeen: "0" }),
        destination({ firstSeen: S(NOW + 3_600_000), lastSeen: S(NOW + 3_600_000) }),
      ]),
      NOW,
    );

    const [fromWindow, future] = written();
    expect(fromWindow.firstSeen).toEqual(new Date(Number(S(NOW - 60_000)) * 1000));
    expect(fromWindow.lastSeen).toEqual(new Date(Number(S(NOW)) * 1000));
    expect(future.lastSeen).toEqual(new Date(NOW));
    expect(future.firstSeen).toEqual(new Date(NOW));
  });

  it("refuses lines that are not destinations, and anything already past retention", async () => {
    const { service, written } = build([{ externalUserId: "user-a", protocol: "XRAY_VLESS_REALITY", customerId: "cust-1" }]);

    await service.record(
      "node-1",
      batch([
        destination({ host: "" }),
        destination({ host: "x".repeat(300) }),
        destination({ port: 70_000 }),
        destination({ lastSeen: S(NOW - (SITE_VISIT_RETENTION_DAYS + 1) * DAY), firstSeen: S(NOW - 9 * DAY) }),
        destination({ host: "  Example.ORG ", network: "UDP", count: 0 }),
      ]),
      NOW,
    );

    expect(written()).toEqual([expect.objectContaining({ host: "Example.ORG", network: "udp", count: 1 })]);
  });

  it("never throws: a failed write must not close the node's control stream", async () => {
    const { service, prisma } = build([{ externalUserId: "user-a", protocol: "XRAY_VLESS_REALITY", customerId: "cust-1" }]);
    prisma.siteVisit.createMany.mockRejectedValue(new Error("foreign key violated"));

    await expect(service.record("node-1", batch([destination()]), NOW)).resolves.toBe(0);
    await expect(service.record("node-1", undefined, NOW)).resolves.toBe(0);
  });
});

describe("SiteVisitsService.prune", () => {
  it("deletes what was last seen more than seven days ago", async () => {
    const { service, prisma } = build();

    expect(await service.prune(NOW)).toBe(4);
    expect(prisma.siteVisit.deleteMany).toHaveBeenCalledWith({ where: { lastSeen: { lt: new Date(NOW - 7 * DAY) } } });
  });
});

describe("SiteVisitsService.sites", () => {
  /** One destination as the grouping query returns it. */
  const row = (over: Record<string, unknown>) => ({
    host: "203.0.113.7",
    port: 443,
    network: "tcp",
    count: BigInt(1),
    firstSeen: new Date(NOW - 5 * DAY),
    lastSeen: new Date(NOW - DAY),
    nodeIds: ["node-1"],
    protocols: ["XRAY_VLESS_REALITY"],
    ...over,
  });

  /** Answers the page query with `rows` and the count query with `total`. */
  function answer(prisma: ReturnType<typeof build>["prisma"], rows: unknown[], total = rows.length) {
    prisma.$queryRaw.mockImplementation((sql: Prisma.Sql) =>
      Promise.resolve(/COUNT\(\*\)/.test(sql.sql) ? [{ total }] : rows),
    );
  }
  const pageQuery = (prisma: ReturnType<typeof build>["prisma"], i = 0) =>
    prisma.$queryRaw.mock.calls.filter((c: [Prisma.Sql]) => !/COUNT\(\*\)/.test(c[0].sql))[i][0] as Prisma.Sql;
  const countQuery = (prisma: ReturnType<typeof build>["prisma"], i = 0) =>
    prisma.$queryRaw.mock.calls.filter((c: [Prisma.Sql]) => /COUNT\(\*\)/.test(c[0].sql))[i][0] as Prisma.Sql;

  it("names servers, sorts servers and protocols, names an address's network, and takes the total from its own count", async () => {
    const { service, prisma, asn } = build();
    answer(
      prisma,
      [
        row({ host: "example.org", port: 80, lastSeen: new Date(NOW - 60_000) }),
        row({
          count: BigInt(7),
          firstSeen: new Date(NOW - 6 * DAY),
          nodeIds: ["node-2", "node-1"],
          protocols: ["XRAY_VLESS_REALITY", "SHADOWSOCKS"],
        }),
        row({ host: "[2001:db8::1]", lastSeen: new Date(NOW - 3 * DAY), nodeIds: ["node-gone"], protocols: [] }),
      ],
      1_234,
    );
    prisma.node.findMany.mockResolvedValue([
      { id: "node-1", name: "alpha" },
      { id: "node-2", name: "beta" },
    ]);
    asn.lookup.mockImplementation((ip: string) =>
      ip === "203.0.113.7" ? { asn: 64500, org: "Example Net" } : ip === "2001:db8::1" ? { asn: 64501, org: "" } : null,
    );

    const view = await service.sites("cust-1", {}, NOW);

    expect(view.retentionDays).toBe(7);
    expect(view.coverage).toBe(SITE_COVERAGE);
    // The count query's answer, not the length of the page.
    expect(view.total).toBe(1_234);
    // In the database's order: the page query sorts.
    expect(view.sites.map((s) => s.host)).toEqual(["example.org", "203.0.113.7", "[2001:db8::1]"]);
    expect(view.sites[1]).toEqual({
      host: "203.0.113.7",
      port: 443,
      network: "tcp",
      owner: "Example Net",
      count: 7,
      firstSeen: new Date(NOW - 6 * DAY).toISOString(),
      lastSeen: new Date(NOW - DAY).toISOString(),
      servers: ["alpha", "beta"],
      protocols: ["SHADOWSOCKS", "XRAY_VLESS_REALITY"],
    });
    // A name has no owner; nor does an address whose network has no name.
    expect(view.sites[0].owner).toBeNull();
    expect(view.sites[2].owner).toBeNull();
    expect(asn.lookup).toHaveBeenCalledWith("2001:db8::1");
    // A server deleted since is named by its id.
    expect(view.sites[2].servers).toEqual(["node-gone"]);
    const asked = (prisma.node.findMany.mock.calls[0] as [{ where: { id: { in: string[] } } }])[0].where.id.in;
    expect([...asked].sort()).toEqual(["node-1", "node-2", "node-gone"]);
  });

  it("groups, orders and limits in the database, so only the page is read into memory", async () => {
    const { service, prisma } = build();
    answer(prisma, []);

    await service.sites("cust-1", {}, NOW);

    const page = pageQuery(prisma).sql.replace(/\s+/g, " ");
    expect(page).toMatch(/GROUP BY "host", "port", "network"/);
    expect(page).toMatch(/ORDER BY MAX\("lastSeen"\) DESC/);
    expect(page).toMatch(/LIMIT \?::int$/);
    expect(countQuery(prisma).sql.replace(/\s+/g, " ")).toMatch(/GROUP BY "host", "port", "network"\) AS "destinations"/);
  });

  it("reads seven days unless told fewer, never more, and filters the host case-insensitively", async () => {
    const { service, prisma } = build();
    answer(prisma, []);

    await service.sites("cust-1", {}, NOW);
    await service.sites("cust-1", { days: "2", q: "  Tele " }, NOW);
    await service.sites("cust-1", { days: "30" }, NOW);
    await service.sites("cust-1", { days: "0" }, NOW);
    await service.sites("cust-1", { days: "soon", q: "   " }, NOW);

    const since = (days: number) => new Date(NOW - days * DAY).toISOString();
    expect(pageQuery(prisma, 0).values).toEqual(["cust-1", since(7), 200]);
    expect(pageQuery(prisma, 1).values).toEqual(["cust-1", since(2), "%Tele%", 200]);
    expect(pageQuery(prisma, 1).sql).toMatch(/"host" ILIKE \?/);
    expect(pageQuery(prisma, 2).values[1]).toBe(since(7));
    expect(pageQuery(prisma, 3).values[1]).toBe(since(1));
    expect(pageQuery(prisma, 4).values).toEqual(["cust-1", since(7), 200]);
    expect(pageQuery(prisma, 4).sql).not.toMatch(/ILIKE/);
    // The count reads exactly what the page reads.
    expect(countQuery(prisma, 1).values).toEqual(["cust-1", since(2), "%Tele%"]);
  });

  it("searches for LIKE's wildcards as themselves", async () => {
    const { service, prisma } = build();
    answer(prisma, []);

    await service.sites("cust-1", { q: String.raw`a_b%c\d` }, NOW);

    expect(pageQuery(prisma).values[2]).toBe(String.raw`%a\_b\%c\\d%`);
  });

  it("asks for at most `take` rows, 200 by default and 1000 at most", async () => {
    const { service, prisma } = build();
    answer(prisma, []);

    await service.sites("cust-1", {}, NOW);
    await service.sites("cust-1", { take: "5000" }, NOW);
    await service.sites("cust-1", { take: "3" }, NOW);

    const limits = [0, 1, 2].map((i) => pageQuery(prisma, i).values.at(-1));
    expect(limits).toEqual([200, 1_000, 3]);
  });

  it("is a 404 for a customer that does not exist", async () => {
    const { service, prisma } = build();
    prisma.customer.findUnique.mockResolvedValue(null);

    await expect(service.sites("nobody", {}, NOW)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("addressOf", () => {
  it("unwraps brackets and IPv4-in-IPv6, and is null for a name", () => {
    expect(addressOf("203.0.113.9")).toBe("203.0.113.9");
    expect(addressOf("[2001:db8::2]")).toBe("2001:db8::2");
    expect(addressOf("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressOf("example.org")).toBeNull();
    expect(addressOf("203.0.113.9.example.org")).toBeNull();
  });
});

describe("boundedInt", () => {
  it("clamps, and falls back for absent or non-numbers", () => {
    expect(boundedInt(undefined, 1, 7, 7)).toBe(7);
    expect(boundedInt("", 1, 7, 7)).toBe(7);
    expect(boundedInt("abc", 1, 7, 7)).toBe(7);
    expect(boundedInt("3.9", 1, 7, 7)).toBe(3);
    expect(boundedInt("-4", 1, 7, 7)).toBe(1);
    expect(boundedInt(99, 1, 7, 7)).toBe(7);
  });
});
