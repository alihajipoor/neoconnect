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

function build(rows: unknown[] = []) {
  const config = new ConfigService({ security: { exitHandleSecret: SECRET }, asn: { enabled: false } });
  const lookup = new AsnLookupService(config);
  lookup.use(
    AsnTable.fromLines([
      "198.51.100.0\t198.51.100.255\t64500\tIR\tEXAMPLE-ISP",
      "203.0.113.0\t203.0.113.255\t64501\tDE\tEXAMPLE-HOST",
    ]),
  );
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = {
    node: { findMany: jest.fn().mockResolvedValue([{ publicIp: NODE_IP, mirrorHost: null }]) },
    clientAttempt: { findMany },
    route: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const service = new IspRecommendationsService(prisma, new NetworkIdentityService(prisma, lookup, config));
  return { service, findMany };
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
    { customerId: `c${i}`, kind: "CONNECT", outcome: "SUCCESS", routeId: "r1", attemptsJson: null, sessionSeconds: null, createdAt: new Date(now - 3_600_000) },
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
