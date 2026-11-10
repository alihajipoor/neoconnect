import { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../../prisma/prisma.service";
import { AsnLookupService } from "../network-identity/asn-lookup.service";
import { AsnTable } from "../network-identity/asn-table";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import { IspRecommendationsService } from "./isp-recommendations.service";
import { MIN_ORDER_CUSTOMERS, ORDER_WINDOW_HOURS } from "./isp-order";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
/** Four ISPs registered in one country -- the caller's and three more,
 * which is how many a verdict for the country has to rest on
 * (`MIN_COUNTRY_NETWORKS`) -- one in another, and one the table does not
 * know. */
const ISP = 64500;
const NEIGHBOUR = 64501;
const ABROAD = 64502;
const NEIGHBOURS = [NEIGHBOUR, 64503, 64504];
const UNPLACED = 64999;

const ROUTES = [
  { id: "s1-reality", exitProtocolConfig: null, entryProtocolConfig: { nodeId: "s1", protocol: "XRAY_VLESS_REALITY", transport: "TCP" } },
  { id: "s1-wg", exitProtocolConfig: null, entryProtocolConfig: { nodeId: "s1", protocol: "WIREGUARD", transport: "TCP" } },
  { id: "s3-reality", exitProtocolConfig: null, entryProtocolConfig: { nodeId: "s3", protocol: "XRAY_VLESS_REALITY", transport: "TCP" } },
];

/** A row as latestDialsSql returns it. */
const row = (customerId: string, asn: number, routeId: string, carried: boolean) => ({
  customerId,
  asn,
  routeId,
  carried,
  happenedAt: new Date(NOW - HOUR),
  createdAt: new Date(NOW - HOUR),
  rung: 1,
});
const each = (asn: number, prefix: string) =>
  Array.from({ length: MIN_ORDER_CUSTOMERS }, (_, i) => [
    row(`${prefix}${i}`, asn, "s1-reality", true),
    row(`${prefix}${i}`, asn, "s1-wg", false),
    row(`${prefix}${i}`, asn, "s3-reality", false),
  ]).flat();

function build(rows: ReturnType<typeof row>[], networks: number[] = [ISP, NEIGHBOUR, ABROAD]) {
  const config = new ConfigService({ security: { exitHandleSecret: "test-secret-not-a-real-one" }, asn: { enabled: false } });
  const lookup = new AsnLookupService(config);
  lookup.use(
    AsnTable.fromLines([
      "198.51.100.0\t198.51.100.127\t64500\tIR\tEXAMPLE-ISP",
      "198.51.100.128\t198.51.100.255\t64501\tIR\tEXAMPLE-NEIGHBOUR",
      "203.0.113.0\t203.0.113.255\t64502\tDE\tEXAMPLE-ABROAD",
      "192.0.2.0\t192.0.2.127\t64503\tIR\tEXAMPLE-THIRD",
      "192.0.2.128\t192.0.2.255\t64504\tIR\tEXAMPLE-FOURTH",
    ]),
  );
  const groupBy = jest.fn().mockResolvedValue(networks.map((asn) => ({ asn })));
  // Answers as the query does: only the networks it was asked for.
  const queryRaw = jest.fn().mockImplementation((sql: { values: unknown[] }) => {
    const asked = new Set(sql.values.slice(1) as number[]);
    return Promise.resolve(rows.filter((r) => asked.has(r.asn)));
  });
  const routes = jest.fn().mockResolvedValue(ROUTES);
  const prisma = {
    node: { findMany: jest.fn().mockResolvedValue([]) },
    clientAttempt: { groupBy, findMany: jest.fn().mockResolvedValue([]) },
    route: { findMany: routes },
    $queryRaw: queryRaw,
  } as unknown as PrismaService;
  const service = new IspRecommendationsService(prisma, new NetworkIdentityService(prisma, lookup, config));
  return { service, groupBy, queryRaw, routes };
}

describe("IspRecommendationsService.hintsFor", () => {
  it("gives nothing, and reads nothing, for an unknown network", async () => {
    const { service, groupBy, queryRaw, routes } = build([]);
    expect((await service.hintsFor(null, NOW)).size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
    expect(routes).not.toHaveBeenCalled();
  });

  /** A hint that says nothing still names the network, so an app can
   * tell which one the list in its hands describes. */
  it("names the network on every route and nothing else when nobody has reported", async () => {
    const { service } = build([]);
    const hints = await service.hintsFor(ISP, NOW);
    expect([...hints.keys()].sort()).toEqual(["s1-reality", "s1-wg", "s3-reality"]);
    for (const hint of hints.values()) expect(hint).toEqual({ asn: ISP });
  });

  it("says how each route's server and protocol have done on the caller's network", async () => {
    const { service } = build(each(ISP, "c"));
    const hints = await service.hintsFor(ISP, NOW);
    expect(hints.get("s1-reality")).toEqual({ asn: ISP, server: "works", protocol: "lands" });
    expect(hints.get("s1-wg")).toEqual({ asn: ISP, server: "works", protocol: "fails" });
    expect(hints.get("s3-reality")).toEqual({ asn: ISP, server: "fails", protocol: "lands" });
  });

  it("reads only signed-in connect reports inside the window, on the caller's country's networks", async () => {
    const { service, groupBy, queryRaw } = build(each(NEIGHBOUR, "n"));
    await service.hintsFor(ISP, NOW);

    const where = (groupBy.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      kind: "CONNECT",
      customerId: { not: null },
      asn: { not: null },
      createdAt: { gte: new Date(NOW - ORDER_WINDOW_HOURS * HOUR) },
    });
    const [since, ...asns] = (queryRaw.mock.calls[0][0] as { values: unknown[] }).values;
    expect(since).toBe(NOW - ORDER_WINDOW_HOURS * HOUR);
    // The other country's network is not asked for.
    expect(asns).toEqual([ISP, NEIGHBOUR]);
  });

  /** Too few customers on the caller's own ISP: the country's stand in. */
  it("falls back to the caller's country where its own network has too little", async () => {
    const { service } = build(
      NEIGHBOURS.flatMap((asn) => each(asn, `on${asn}-`)),
      [ISP, ...NEIGHBOURS, ABROAD],
    );
    const hints = await service.hintsFor(ISP, NOW);
    expect(hints.get("s1-reality")).toEqual({ asn: ISP, server: "works", protocol: "lands" });
    expect(hints.get("s3-reality")).toEqual({ asn: ISP, server: "fails", protocol: "lands" });
  });

  /** Which server works goes by the ISP: one neighbouring network's
   * customers do not speak for the country. */
  it("takes nothing from a single other network in the country", async () => {
    const { service } = build(each(NEIGHBOUR, "n"));
    for (const hint of (await service.hintsFor(ISP, NOW)).values()) expect(hint).toEqual({ asn: ISP });
    // Its own customers are told what they saw.
    expect((await service.hintsFor(NEIGHBOUR, NOW)).get("s3-reality")).toEqual({
      asn: NEIGHBOUR,
      server: "fails",
      protocol: "lands",
    });
  });

  it("takes nothing from another country's networks", async () => {
    const { service } = build(each(ABROAD, "a"));
    for (const hint of (await service.hintsFor(ISP, NOW)).values()) expect(hint).toEqual({ asn: ISP });
  });

  /** A network the table cannot place has no country to fall back to:
   * its own reports alone, with no scan for the others. */
  it("reads the caller's network alone when its country is unknown", async () => {
    const { service, groupBy, queryRaw } = build(
      [...each(NEIGHBOUR, "n"), ...each(UNPLACED, "u")],
      [ISP, NEIGHBOUR, UNPLACED],
    );
    const hints = await service.hintsFor(UNPLACED, NOW);
    expect(groupBy).not.toHaveBeenCalled();
    expect((queryRaw.mock.calls[0][0] as { values: unknown[] }).values.slice(1)).toEqual([UNPLACED]);
    expect(hints.get("s1-reality")).toEqual({ asn: UNPLACED, server: "works", protocol: "lands" });
  });

  it("reuses one country's reads for every network in it, for ten minutes", async () => {
    const { service, groupBy, queryRaw, routes } = build(each(NEIGHBOUR, "n"));
    await service.hintsFor(ISP, NOW);
    await service.hintsFor(ISP, NOW + 9 * 60_000);
    await service.hintsFor(NEIGHBOUR, NOW + 9 * 60_000);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(routes).toHaveBeenCalledTimes(1);

    await service.hintsFor(ISP, NOW + 11 * 60_000);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  /** Nothing in a hint is a count or a person: three values and the
   * caller's own network. */
  it("returns nothing that names a customer", async () => {
    const { service } = build(each(ISP, "c"));
    const text = JSON.stringify([...(await service.hintsFor(ISP, NOW)).values()]);
    expect(text).not.toMatch(/c0|c1|c2|customer/);
  });
});
