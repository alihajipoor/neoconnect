import { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../../prisma/prisma.service";
import { AsnLookupService } from "../network-identity/asn-lookup.service";
import { AsnTable } from "../network-identity/asn-table";
import { networkAttestor } from "../network-identity/network-attestation";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import { IspRecommendationsService } from "./isp-recommendations.service";
import { MIN_CUSTOMERS, SUSTAINED_SECONDS, WINDOW_HOURS } from "./isp-signal";

const SECRET = "test-secret-not-a-real-one";
const NODE_IP = "203.0.113.20";

function build(rows: unknown[] = [], usage: unknown[] = [], routes: unknown[] = []) {
  const config = new ConfigService({ security: { exitHandleSecret: SECRET }, asn: { enabled: false } });
  const lookup = new AsnLookupService(config);
  lookup.use(
    AsnTable.fromLines([
      "198.51.100.0\t198.51.100.255\t64500\tIR\tEXAMPLE-ISP",
      "203.0.113.0\t203.0.113.255\t64501\tDE\tEXAMPLE-HOST",
    ]),
  );
  const findMany = jest.fn().mockResolvedValue(rows);
  const queryRaw = jest.fn().mockResolvedValue(usage);
  const prisma = {
    node: { findMany: jest.fn().mockResolvedValue([{ id: "n1", publicIp: NODE_IP, mirrorHost: null }]) },
    clientAttempt: { findMany },
    route: { findMany: jest.fn().mockResolvedValue(routes) },
    $queryRaw: queryRaw,
  } as unknown as PrismaService;
  const service = new IspRecommendationsService(prisma, new NetworkIdentityService(prisma, lookup, config));
  return { service, findMany, queryRaw };
}

describe("IspRecommendationsService.networkFor", () => {
  /** The route list is often fetched through the tunnel; the attestation
   * is the reading taken before it, so it wins. */
  it("prefers the client's attestation over the request address", async () => {
    const { service } = build();
    const token = networkAttestor(SECRET).issue(64500);
    expect(await service.networkFor(token!, NODE_IP)).toBe(64500);
  });

  it("falls back to the request address when there is no attestation", async () => {
    const { service } = build();
    expect(await service.networkFor(undefined, "198.51.100.9")).toBe(64500);
  });

  /** Through the tunnel with no attestation, the request comes from a
   * node. Its data centre is not the customer's ISP, and showing its
   * tags would be showing somebody else's. */
  it("gives no network for a request from one of our nodes", async () => {
    const { service } = build();
    expect(await service.networkFor(undefined, NODE_IP)).toBeNull();
    expect(await service.networkFor("forged-token", NODE_IP)).toBeNull();
  });
});

describe("IspRecommendationsService.tagsFor", () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const rows = Array.from({ length: MIN_CUSTOMERS }, (_, i) => [
    { customerId: `c${i}`, kind: "CONNECT", outcome: "SUCCESS", routeId: "r1", attemptsJson: [{ protocol: "Fast", result: "connected", routeId: "r1", carried: true }], sessionSeconds: null, createdAt: new Date(now - 3_600_000) },
    { customerId: `c${i}`, kind: "SESSION", outcome: "SUCCESS", routeId: "r1", attemptsJson: null, sessionSeconds: SUSTAINED_SECONDS, createdAt: new Date(now - 1_800_000) },
  ]).flat();

  it("asks only for this network's signed-in reports inside the window", async () => {
    const { service, findMany } = build(rows);
    const tags = await service.tagsFor(64500, now);
    expect(tags.get("r1")?.code).toBe("worksOnYourIsp");

    const query = findMany.mock.calls[0][0] as {
      where: { asn: number; customerId: unknown; createdAt: { gte: Date } };
      select: Record<string, boolean>;
    };
    expect(query.where.asn).toBe(64500);
    expect(query.where.customerId).toEqual({ not: null });
    expect(query.where.createdAt.gte.getTime()).toBe(now - WINDOW_HOURS * 3_600_000);
    // Named columns: the row's IP address is never read for this.
    expect(query.select).not.toHaveProperty("ip");
  });

  it("serves a repeat from cache", async () => {
    const { service, findMany } = build(rows);
    await service.tagsFor(64500, now);
    await service.tagsFor(64500, now + 60_000);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("returns nothing, without a query, for an unknown network", async () => {
    const { service, findMany } = build(rows);
    expect((await service.tagsFor(null, now)).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("IspRecommendationsService.adminSummary traffic", () => {
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  const MB = 1 << 20;
  const dial = (customerId: string, routeId: string, at: number) => ({
    customerId,
    asn: 64500,
    kind: "CONNECT",
    outcome: "SUCCESS",
    routeId,
    attemptsJson: [{ protocol: "Fast", result: "connected", routeId, carried: true }],
    sessionSeconds: null,
    createdAt: new Date(at),
    occurredAt: new Date(at),
  });
  const session = (customerId: string, routeId: string, at: number) => ({
    ...dial(customerId, routeId, at),
    kind: "SESSION",
    attemptsJson: null,
    sessionSeconds: SUSTAINED_SECONDS,
  });
  const usage = (customerId: string, routeId: string | null, up: number, down: number) => ({
    customerId,
    routeId,
    until: BigInt(now - 3_600_000),
    up: String(up),
    down: String(down),
  });
  const route = (id: string) => ({
    id,
    name: `Route ${id}`,
    exitProtocolConfigId: null,
    entryProtocolConfig: { protocol: "VLESS_REALITY", transport: "TCP", node: { name: "node-a" } },
  });

  it("puts metered bytes beside the counts, and shows what it cannot place", async () => {
    const { service, queryRaw } = build(
      [dial("c1", "r1", now - 5 * 3_600_000), session("c2", "r2", now - 5 * 3_600_000)],
      [
        usage("c1", "r1", 3 * MB, 40 * MB),
        usage("c2", "r2", 2 * MB, 5 * MB), // a session on r2 but no dial: shown, nobody "tried"
        usage("c3", "r1", 0, 700 * MB), // no report anywhere: unattributed, download only
        usage("c4", null, 1, 2), // credential removed since
      ],
      [route("r1"), route("r2")],
    );
    const summary = await service.adminSummary(now);

    const network = summary.networks.find((n) => n.asn === 64500)!;
    const r1 = network.routes.find((r) => r.routeId === "r1")!;
    expect(r1).toMatchObject({ tried: 1, carried: 1, routeName: "Route r1" });
    expect(r1.traffic).toEqual({
      bytesUp: String(3 * MB),
      bytesDown: String(40 * MB),
      customers: 1,
      withUpload: 1,
      typicalBytes: String(43 * MB),
    });
    const r2 = network.routes.find((r) => r.routeId === "r2")!;
    expect(r2).toMatchObject({ tried: 0, tag: null, traffic: { customers: 1, withUpload: 1 } });

    expect(summary.unattributed).toEqual([
      expect.objectContaining({
        routeId: "r1",
        traffic: { bytesUp: "0", bytesDown: String(700 * MB), customers: 1, withUpload: 0, typicalBytes: null },
      }),
    ]);
    expect(summary.withoutRoute).toEqual({ bytesUp: "1", bytesDown: "2", customers: 1 });

    // One grouped query over the window, bounded below by its start.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const values = (queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(values).toContain(new Date(now - WINDOW_HOURS * 3_600_000).toISOString());
  });
});
