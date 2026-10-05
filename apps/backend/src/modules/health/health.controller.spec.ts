import { ConfigService } from "@nestjs/config";
import { HealthController } from "./health.controller";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Request } from "express";
import { AsnLookupService } from "../network-identity/asn-lookup.service";
import { AsnTable } from "../network-identity/asn-table";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import { networkAttestor } from "../network-identity/network-attestation";

const SECRET = "test-secret-not-a-real-one";

/** A controller over a small ASN table: 198.51.100.0/24 is a customer
 * ISP, 203.0.113.0/24 a hosting provider with one of our nodes on
 * 203.0.113.20. All RFC 5737 documentation ranges. */
function build(nodes: Array<{ publicIp: string; mirrorHost: string | null }> = []) {
  const config = new ConfigService({ security: { exitHandleSecret: SECRET }, asn: { enabled: false } });
  const lookup = new AsnLookupService(config);
  lookup.use(
    AsnTable.fromLines([
      "198.51.100.0\t198.51.100.255\t64500\tIR\tEXAMPLE-ISP Example Carrier",
      "203.0.113.0\t203.0.113.255\t64501\tDE\tEXAMPLE-HOST Example Hosting",
    ]),
  );
  const prisma = { node: { findMany: jest.fn().mockResolvedValue(nodes) } } as unknown as PrismaService;
  const identity = new NetworkIdentityService(prisma, lookup, config);
  return new HealthController(prisma, identity);
}

/** The client compares this value before and after connecting to prove
 * its traffic actually moved. Returning a proxy's address instead of the
 * caller's makes both readings identical, which the app correctly reads
 * as "the tunnel is carrying nothing" -- reporting every working
 * connection as unprotected. */
describe("HealthController.ip", () => {
  const controller = build();
  const ask = async (headers: Record<string, string>, socketIp = "10.0.0.1") =>
    (await controller.ip(socketIp, { headers } as unknown as Request)).ip;

  it("returns the socket address when nothing is proxying", async () => {
    expect(await ask({})).toBe("10.0.0.1");
  });

  /** Measured against production: through the CDN this returned
   * 162.158.41.5 while the caller was 50.47.175.127. */
  it("prefers Cloudflare's header over the hop it arrived from", async () => {
    expect(
      await ask({
        "cf-connecting-ip": "50.47.175.127",
        "x-forwarded-for": "50.47.175.127, 162.158.41.5",
        "x-real-ip": "162.158.41.5",
      }),
    ).toBe("50.47.175.127");
  });

  /** A node's API mirror adds a hop, so the chain grows on the right.
   * The client stays leftmost. */
  it("takes the client end of a forwarded chain, not the last proxy", async () => {
    expect(
      await ask({ "x-forwarded-for": "50.47.175.127, 204.168.161.100", "x-real-ip": "204.168.161.100" }),
    ).toBe("50.47.175.127");
  });

  /** X-Real-IP is the immediate peer, which is only the client when
   * nothing else forwarded the request. */
  it("falls back to X-Real-IP when there is no forwarded chain", async () => {
    expect(await ask({ "x-real-ip": "50.47.175.127" })).toBe("50.47.175.127");
  });
});

/** The pre-connect baseline is the one moment the server sees the
 * customer's own address, so it is where their network is read. */
describe("HealthController.ip network", () => {
  const from = (ip: string) => ({ headers: { "cf-connecting-ip": ip } }) as unknown as Request;

  it("names the caller's network and signs it", async () => {
    const answer = await build().ip("10.0.0.1", from("198.51.100.7"));
    expect(answer).toMatchObject({ asn: 64500, asnOrg: "EXAMPLE-ISP Example Carrier" });
    // The token has to round-trip: it is what reports carry back.
    expect(networkAttestor(SECRET).verify((answer as { network?: string }).network)).toBe(64500);
  });

  /** The after-connect egress check asks from the node. Believed, that
   * would file every success through a node under the node's own data
   * centre -- which would then "work well" by construction. */
  it("says nothing about the network when the caller is one of our nodes", async () => {
    const answer = await build([{ publicIp: "203.0.113.20", mirrorHost: null }]).ip("10.0.0.1", from("203.0.113.20"));
    expect(answer).toEqual({ ip: "203.0.113.20", country: undefined });
  });

  /** Exact addresses, not whole networks: a neighbour of a node in the
   * same ASN is still a customer. */
  it("still names the network of an address next to a node", async () => {
    const answer = await build([{ publicIp: "203.0.113.20", mirrorHost: null }]).ip("10.0.0.1", from("203.0.113.21"));
    expect(answer).toMatchObject({ asn: 64501 });
  });

  /** Not knowing which addresses are ours is not a reason to believe
   * none are. */
  it("fails closed when the node list cannot be read", async () => {
    const config = new ConfigService({ security: { exitHandleSecret: SECRET }, asn: { enabled: false } });
    const lookup = new AsnLookupService(config);
    lookup.use(AsnTable.fromLines(["198.51.100.0\t198.51.100.255\t64500\tIR\tEXAMPLE-ISP"]));
    const prisma = { node: { findMany: jest.fn().mockRejectedValue(new Error("db down")) } } as unknown as PrismaService;
    const controller = new HealthController(prisma, new NetworkIdentityService(prisma, lookup, config));
    const answer = await controller.ip("10.0.0.1", from("198.51.100.7"));
    expect(answer).not.toHaveProperty("asn");
  });

  it("answers the address alone while no table is loaded", async () => {
    const config = new ConfigService({ asn: { enabled: false } });
    const prisma = { node: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const lookup = new AsnLookupService(config);
    const controller = new HealthController(prisma, new NetworkIdentityService(prisma, lookup, config));
    expect(await controller.ip("10.0.0.1", from("198.51.100.7"))).toEqual({ ip: "198.51.100.7", country: undefined });
  });
});
